'use strict';

const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');

const MAX_NAME_LEN = 40;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

/**
 * Load and validate quiz questions from a JSON file.
 * Expected shape: [{ question: string, options: string[2-6], correctIndex: number }]
 */
function loadQuestions(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('quiz file must be a non-empty JSON array');
  }
  return data.map((q, i) => {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      throw new Error(`question ${i} is missing "question" text`);
    }
    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      throw new Error(`question ${i} must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} options`);
    }
    if (q.options.some((o) => typeof o !== 'string' || !o.trim())) {
      throw new Error(`question ${i} has an empty option`);
    }
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
      throw new Error(`question ${i} has an invalid correctIndex`);
    }
    return { question: q.question.trim(), options: q.options.map((o) => o.trim()), correctIndex: q.correctIndex };
  });
}

/**
 * Host-run, Slido/Kahoot-style live quiz. Single quiz "room" per server
 * process — this app is built for one party at a time.
 */
class QuizEngine extends EventEmitter {
  constructor(questions, { answerWindowMs = 20000 } = {}) {
    super();
    this.questions = questions;
    this.answerWindowMs = answerWindowMs;
    this.status = 'idle'; // idle | question | reveal | ended
    this.index = -1;
    this.questionStartedAt = 0;
    this.players = new Map(); // playerId -> { name, score }
    this.answers = new Map(); // playerId -> { optionIndex, at }
    // Bumped on every reset so clients holding a stale playerId know to re-join.
    this.generation = 1;
  }

  setQuestions(questions) {
    this.questions = questions;
    this.reset();
  }

  reset() {
    this.status = 'idle';
    this.index = -1;
    this.questionStartedAt = 0;
    this.players.clear();
    this.answers.clear();
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

  start() {
    if (this.questions.length === 0) throw new Error('No questions loaded');
    this.index = 0;
    this.status = 'question';
    this.questionStartedAt = Date.now();
    this.answers.clear();
    this.emit('update');
  }

  next() {
    if (this.index + 1 >= this.questions.length) {
      this.end();
      return;
    }
    this.index += 1;
    this.status = 'question';
    this.questionStartedAt = Date.now();
    this.answers.clear();
    this.emit('update');
  }

  reveal() {
    if (this.status !== 'question') return;
    const q = this.questions[this.index];
    for (const [playerId, answer] of this.answers) {
      const player = this.players.get(playerId);
      if (!player || answer.optionIndex !== q.correctIndex) continue;
      const elapsed = answer.at - this.questionStartedAt;
      const remaining = Math.max(0, Math.min(1, 1 - elapsed / this.answerWindowMs));
      player.score += Math.round(500 + 500 * remaining);
    }
    this.status = 'reveal';
    this.emit('update');
  }

  end() {
    this.status = 'ended';
    this.emit('update');
  }

  submitAnswer(playerId, optionIndex) {
    if (this.status !== 'question') throw new Error('No question is currently open');
    if (!this.players.has(playerId)) throw new Error('Unknown player');
    const q = this.questions[this.index];
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
    const q = this.questions[this.index];
    const counts = new Array(q.options.length).fill(0);
    for (const answer of this.answers.values()) counts[answer.optionIndex] += 1;
    return counts;
  }

  /** Safe-to-broadcast state. Hides the correct answer until reveal/ended. */
  publicState() {
    const total = this.questions.length;
    const base = {
      status: this.status,
      index: this.index,
      total,
      totalPlayers: this.players.size,
      answeredCount: this.answers.size,
      generation: this.generation
    };
    if (this.index < 0 || !this.questions[this.index]) return base;

    const q = this.questions[this.index];
    base.question = { text: q.question, options: q.options };
    if (this.status === 'question') {
      base.deadline = this.questionStartedAt + this.answerWindowMs;
      base.windowMs = this.answerWindowMs;
    }
    if (this.status === 'reveal' || this.status === 'ended') {
      base.correctIndex = q.correctIndex;
      base.optionCounts = this.optionCounts();
    }
    if (this.status === 'reveal' || this.status === 'ended') {
      base.leaderboard = this.leaderboard();
    }
    return base;
  }

  /** Full state for the host, including live vote counts while a question is open. */
  hostState() {
    const state = this.publicState();
    if (this.index >= 0 && this.questions[this.index]) {
      state.correctIndex = this.questions[this.index].correctIndex;
      state.optionCounts = this.optionCounts();
    }
    state.leaderboard = this.leaderboard();
    return state;
  }
}

module.exports = { QuizEngine, loadQuestions };
