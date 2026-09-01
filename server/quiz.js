'use strict';

const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

const MAX_NAME_LEN = 40;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/** Fisher-Yates shuffle of [0..n-1], returning the shuffled index order. */
function shuffledIndices(n) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function validateQuestion(q, label) {
  if (!q || typeof q.question !== 'string' || !q.question.trim()) {
    throw new Error(`${label} is missing "question" text`);
  }
  if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
    throw new Error(`${label} must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} options`);
  }
  if (q.options.some((o) => typeof o !== 'string' || !o.trim())) {
    throw new Error(`${label} has an empty option`);
  }
  if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
    throw new Error(`${label} has an invalid correctIndex`);
  }
  const options = q.options.map((o) => o.trim());
  if (q.lettersOnly) {
    const letters = options.map((o) => o[0].toUpperCase());
    if (new Set(letters).size !== letters.length) {
      throw new Error(`${label} has options starting with duplicate letters`);
    }
  }
  return { question: q.question.trim(), options, correctIndex: q.correctIndex, lettersOnly: !!q.lettersOnly };
}

/**
 * Load and validate quiz rounds from a JSON file.
 * Expected shape: { rounds: [{ name: string, questions: [{ question, options, correctIndex, lettersOnly? }] }] }
 * lettersOnly questions (e.g. a physical taste test) show players only each
 * option's first letter, so no two options in that question may share one.
 */
function loadQuestions(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.rounds) || data.rounds.length === 0) {
    throw new Error('quiz file must be an object with a non-empty "rounds" array');
  }
  return data.rounds.map((round, ri) => {
    if (!round || typeof round.name !== 'string' || !round.name.trim()) {
      throw new Error(`round ${ri} is missing a "name"`);
    }
    if (!Array.isArray(round.questions) || round.questions.length === 0) {
      throw new Error(`round "${round.name}" must have at least one question`);
    }
    const questions = round.questions.map((q, qi) => validateQuestion(q, `round "${round.name}" question ${qi}`));
    return { name: round.name.trim(), questions };
  });
}

/**
 * Host-run, Slido/Kahoot-style live quiz, organized into rounds. Single quiz
 * "room" per server process — this app is built for one party at a time.
 * The host must explicitly start each round; the quiz doesn't auto-advance
 * from one round into the next.
 */
class QuizEngine extends EventEmitter {
  constructor(rounds, { answerWindowMs = 20000 } = {}) {
    super();
    this.rounds = rounds;
    this.answerWindowMs = answerWindowMs;
    this.status = 'idle'; // idle | question | reveal | round-ended | ended
    this.roundIndex = -1;
    this.questionIndex = -1;
    this.questionStartedAt = 0;
    this.players = new Map(); // playerId -> { name, score }
    this.answers = new Map(); // playerId -> { optionIndex, at }
    // Random per-question option order, regenerated every time a question is shown.
    this.shuffle = [];
    this.shuffledCorrectIndex = -1;
    // Bumped on every reset so clients holding a stale playerId know to re-join.
    this.generation = 1;
  }

  setQuestions(rounds) {
    this.rounds = rounds;
    this.reset();
  }

  currentRound() {
    return this.roundIndex >= 0 ? this.rounds[this.roundIndex] || null : null;
  }

  currentQuestion() {
    const round = this.currentRound();
    return round ? round.questions[this.questionIndex] || null : null;
  }

  /** Picks a fresh random option order for the question that's about to be shown. */
  shuffleCurrentQuestion() {
    const q = this.currentQuestion();
    if (!q) {
      this.shuffle = [];
      this.shuffledCorrectIndex = -1;
      return;
    }
    this.shuffle = shuffledIndices(q.options.length);
    this.shuffledCorrectIndex = this.shuffle.indexOf(q.correctIndex);
  }

  /** The current question's options in this run's shuffled display order. */
  shuffledOptions() {
    const q = this.currentQuestion();
    return q ? this.shuffle.map((i) => q.options[i]) : [];
  }

  reset() {
    this.status = 'idle';
    this.roundIndex = -1;
    this.questionIndex = -1;
    this.questionStartedAt = 0;
    this.players.clear();
    this.answers.clear();
    this.shuffle = [];
    this.shuffledCorrectIndex = -1;
    this.generation += 1;
    this.emit('update');
  }

  join(name) {
    const clean = String(name || '').trim().slice(0, MAX_NAME_LEN);
    if (!clean) throw new Error('Name is required');
    const playerId = crypto.randomUUID();
    this.players.set(playerId, { name: clean, score: 0 });
    this.emit('update');
    return { playerId, generation: this.generation };
  }

  /** Begins the next round. Only allowed before the quiz starts, or after a round has ended. */
  startRound() {
    if (this.status !== 'idle' && this.status !== 'round-ended') {
      throw new Error('A round is already in progress');
    }
    if (this.roundIndex + 1 >= this.rounds.length) throw new Error('No more rounds');
    this.roundIndex += 1;
    this.questionIndex = 0;
    this.status = 'question';
    this.questionStartedAt = Date.now();
    this.answers.clear();
    this.shuffleCurrentQuestion();
    this.emit('update');
  }

  /** Advances to the next question, or ends the round/quiz if none remain. */
  next() {
    const round = this.currentRound();
    if (!round || (this.status !== 'question' && this.status !== 'reveal')) {
      throw new Error('No active round');
    }
    if (this.questionIndex + 1 >= round.questions.length) {
      this.status = this.roundIndex + 1 >= this.rounds.length ? 'ended' : 'round-ended';
      this.emit('update');
      return;
    }
    this.questionIndex += 1;
    this.status = 'question';
    this.questionStartedAt = Date.now();
    this.answers.clear();
    this.shuffleCurrentQuestion();
    this.emit('update');
  }

  reveal() {
    if (this.status !== 'question') return;
    const q = this.currentQuestion();
    if (!q) return;
    for (const [playerId, answer] of this.answers) {
      const player = this.players.get(playerId);
      if (!player || answer.optionIndex !== this.shuffledCorrectIndex) continue;
      const elapsed = answer.at - this.questionStartedAt;
      const remaining = Math.max(0, Math.min(1, 1 - elapsed / this.answerWindowMs));
      player.score += Math.round(500 + 500 * remaining);
    }
    this.status = 'reveal';
    this.emit('update');
  }

  /** Ends the whole quiz early, regardless of how many rounds remain. */
  end() {
    this.status = 'ended';
    this.emit('update');
  }

  submitAnswer(playerId, optionIndex) {
    if (this.status !== 'question') throw new Error('No question is currently open');
    if (!this.players.has(playerId)) throw new Error('Unknown player');
    const q = this.currentQuestion();
    if (!q) throw new Error('No question is currently open');
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= q.options.length) {
      throw new Error('Invalid option');
    }
    if (this.answers.has(playerId)) throw new Error('Already answered');
    if (Date.now() - this.questionStartedAt > this.answerWindowMs) throw new Error('Time is up');
    this.answers.set(playerId, { optionIndex, at: Date.now() });
    this.emit('update');
  }

  leaderboard(limit = 10) {
    return [...this.players.values()]
      .map(({ name, score }) => ({ name, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  optionCounts() {
    const q = this.currentQuestion();
    if (!q) return [];
    const counts = new Array(q.options.length).fill(0);
    for (const answer of this.answers.values()) counts[answer.optionIndex] += 1;
    return counts;
  }

  /** Safe-to-broadcast state. Hides the correct answer, and letters-only names, until reveal. */
  publicState() {
    const round = this.currentRound();
    const base = {
      status: this.status,
      roundIndex: this.roundIndex,
      totalRounds: this.rounds.length,
      roundName: round ? round.name : null,
      questionIndex: this.questionIndex,
      roundQuestionTotal: round ? round.questions.length : 0,
      totalPlayers: this.players.size,
      answeredCount: this.answers.size,
      generation: this.generation
    };

    if (this.status === 'round-ended' || this.status === 'ended') {
      base.leaderboard = this.leaderboard();
      return base;
    }

    const q = this.currentQuestion();
    if (!q) return base;

    const revealed = this.status === 'reveal';
    const shuffled = this.shuffledOptions();
    const displayLetters = q.lettersOnly && !revealed;
    const displayOptions = displayLetters ? shuffled.map((o) => o[0].toUpperCase()) : shuffled;
    base.question = { text: q.question, options: displayOptions, lettersOnly: displayLetters };
    if (this.status === 'question') {
      base.deadline = this.questionStartedAt + this.answerWindowMs;
      base.windowMs = this.answerWindowMs;
    }
    if (revealed) {
      base.correctIndex = this.shuffledCorrectIndex;
      base.optionCounts = this.optionCounts();
      base.leaderboard = this.leaderboard();
    }
    return base;
  }

  /** Full state for the host, including live vote counts and full option names. */
  hostState() {
    const state = this.publicState();
    const q = this.currentQuestion();
    if (q) {
      state.question = { text: q.question, options: this.shuffledOptions() };
      state.correctIndex = this.shuffledCorrectIndex;
      state.optionCounts = this.optionCounts();
    }
    state.leaderboard = this.leaderboard();
    return state;
  }
}

module.exports = { QuizEngine, loadQuestions };

