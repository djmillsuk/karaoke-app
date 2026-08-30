'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Songbook, MAX_RESULTS } = require('./songbook');
const { QuizEngine, loadQuestions } = require('./quiz');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const CSV_PATH = path.resolve(process.env.CSV_PATH || path.join(__dirname, '..', 'data', 'songs.csv'));
const QUIZ_PATH = path.resolve(process.env.QUIZ_PATH || path.join(__dirname, '..', 'data', 'quiz.json'));
const QUIZ_ANSWER_MS = Number(process.env.QUIZ_ANSWER_MS) || 20000;
const QUIZ_HOST_KEY_PATH = path.resolve(process.env.QUIZ_HOST_KEY_PATH || path.join(__dirname, '..', 'data', '.quiz-host-key'));
const DEFAULT_QUIZ_HOST_KEY = 'slp07491514';
const MIN_HOST_KEY_LEN = 6;
const MAX_HOST_KEY_LEN = 100;

/** Persisted override takes priority so a key change survives a restart. */
function loadHostKey() {
  try {
    const saved = fs.readFileSync(QUIZ_HOST_KEY_PATH, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // no saved override yet
  }
  return process.env.QUIZ_HOST_KEY || DEFAULT_QUIZ_HOST_KEY;
}

let quizHostKey = loadHostKey();

const book = new Songbook();
let artistPayload = { body: '[]', etag: '"empty"' };

function buildArtistPayload() {
  const body = JSON.stringify(book.artistList());
  const etag = '"' + crypto.createHash('sha1').update(body).digest('hex') + '"';
  artistPayload = { body, etag };
}

function load() {
  const stats = book.loadFromFile(CSV_PATH);
  buildArtistPayload();
  console.log(`Loaded ${stats.songs} songs by ${stats.artists} artists from ${CSV_PATH}`);
}

try {
  load();
} catch (err) {
  console.error(`Failed to load CSV: ${err.message}`);
  console.error('Set CSV_PATH or place your file at data/songs.csv, then restart.');
  process.exit(1);
}

// Hot-reload the songbook when the CSV changes on disk.
let reloadTimer = null;
fs.watchFile(CSV_PATH, { interval: 5000 }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      load();
    } catch (err) {
      console.error(`Reload failed, keeping previous data: ${err.message}`);
    }
  }, 1000);
});

// The quiz is optional — the songbook still works fine without a quiz file present.
let quiz = null;
try {
  quiz = new QuizEngine(loadQuestions(QUIZ_PATH), { answerWindowMs: QUIZ_ANSWER_MS });
  quiz.on('update', () => broadcastQuiz());
  const totalQuestions = quiz.rounds.reduce((sum, r) => sum + r.questions.length, 0);
  console.log(`Loaded ${quiz.rounds.length} quiz rounds (${totalQuestions} questions) from ${QUIZ_PATH}`);
  console.log(`Quiz host key: ${quizHostKey} (change it from the host page, or set QUIZ_HOST_KEY)`);
} catch (err) {
  console.warn(`Quiz disabled: ${err.message}`);
}

const sseClients = new Set();
function broadcastQuiz() {
  if (!quiz) return;
  const payload = `data: ${JSON.stringify(quiz.publicState())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

/** Constant-time comparison of the host key so it can't be brute-forced via timing. */
function isValidHostKey(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(quizHostKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireHostKey(req, res, next) {
  if (!isValidHostKey(req.headers['x-quiz-host-key'])) return res.status(401).json({ error: 'Invalid host key' });
  next();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.get('/api/artists', (req, res) => {
  res.set('ETag', artistPayload.etag);
  res.set('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === artistPayload.etag) return res.status(304).end();
  res.type('application/json').send(artistPayload.body);
});

app.get('/api/artists/:key/songs', (req, res) => {
  const result = book.songsForArtist(req.params.key);
  if (!result) return res.status(404).json({ error: 'Artist not found' });
  res.json(result);
});

app.get('/api/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const results = book.search(q, MAX_RESULTS);
  res.json({ query: q, limit: MAX_RESULTS, count: results.length, results });
});

app.get('/api/random', (req, res) => {
  const song = book.randomSong();
  if (!song) return res.status(404).json({ error: 'No songs loaded' });
  res.json(song);
});

app.get('/api/stats', (req, res) => {
  res.json({
    songs: book.songs.length,
    artists: book.artists.length,
    loadedAt: book.loadedAt
  });
});

function requireQuiz(req, res, next) {
  if (!quiz) return res.status(404).json({ error: 'Quiz is not configured on this server' });
  next();
}

// --- Quiz: player-facing routes ---

app.get('/api/quiz/state', requireQuiz, (req, res) => {
  res.json(quiz.publicState());
});

app.get('/api/quiz/events', requireQuiz, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(quiz.publicState())}\n\n`);
  sseClients.add(res);

  // Keep the connection alive through proxies (e.g. Traefik) that time out idle streams.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.post('/api/quiz/join', requireQuiz, (req, res) => {
  try {
    const { playerId, generation } = quiz.join(req.body && req.body.name);
    res.json({ playerId, generation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/quiz/answer', requireQuiz, (req, res) => {
  try {
    const { playerId, optionIndex } = req.body || {};
    quiz.submitAnswer(playerId, optionIndex);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Quiz: host-only routes ---

app.get('/api/quiz/host/state', requireQuiz, requireHostKey, (req, res) => {
  res.json(quiz.hostState());
});

app.post('/api/quiz/host/key', requireHostKey, (req, res) => {
  const newKey = String((req.body && req.body.newKey) || '').trim();
  if (newKey.length < MIN_HOST_KEY_LEN || newKey.length > MAX_HOST_KEY_LEN) {
    return res.status(400).json({ error: `Key must be ${MIN_HOST_KEY_LEN}-${MAX_HOST_KEY_LEN} characters` });
  }
  try {
    fs.writeFileSync(QUIZ_HOST_KEY_PATH, newKey, { mode: 0o600 });
  } catch (err) {
    return res.status(500).json({ error: `Could not save key: ${err.message}` });
  }
  quizHostKey = newKey;
  res.json({ ok: true });
});

for (const [route, action] of [
  ['start-round', () => quiz.startRound()],
  ['next', () => quiz.next()],
  ['reveal', () => quiz.reveal()],
  ['end', () => quiz.end()],
  ['reset', () => quiz.reset()]
]) {
  app.post(`/api/quiz/host/${route}`, requireQuiz, requireHostKey, (req, res) => {
    try {
      action();
      res.json(quiz.hostState());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

// ETag revalidation instead of a long max-age, so updated assets are picked up immediately.
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

app.listen(PORT, HOST, () => {
  console.log(`Karaoke songbook listening on http://${HOST}:${PORT}`);
});
