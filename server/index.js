'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Songbook, MAX_RESULTS } = require('./songbook');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const CSV_PATH = path.resolve(process.env.CSV_PATH || path.join(__dirname, '..', 'data', 'songs.csv'));

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

const app = express();
app.disable('x-powered-by');

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

// ETag revalidation instead of a long max-age, so updated assets are picked up immediately.
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

app.listen(PORT, HOST, () => {
  console.log(`Karaoke songbook listening on http://${HOST}:${PORT}`);
});
