'use strict';

const PLAYER_KEY = 'karaoke.quiz.player.v1';

const el = {
  joinView: document.getElementById('join-view'),
  joinForm: document.getElementById('join-form'),
  joinName: document.getElementById('join-name'),
  quizView: document.getElementById('quiz-view'),
  quizStatus: document.getElementById('quiz-status'),
  waitingView: document.getElementById('waiting-view'),
  waitingHeading: document.getElementById('waiting-heading'),
  roundEndedView: document.getElementById('round-ended-view'),
  roundEndedHeading: document.getElementById('round-ended-heading'),
  roundLeaderboard: document.getElementById('round-leaderboard'),
  questionView: document.getElementById('question-view'),
  timerFill: document.getElementById('timer-fill'),
  questionText: document.getElementById('question-text'),
  options: document.getElementById('options'),
  answerNote: document.getElementById('answer-note'),
  revealView: document.getElementById('reveal-view'),
  revealHeading: document.getElementById('reveal-heading'),
  revealOptions: document.getElementById('reveal-options'),
  leaderboard: document.getElementById('leaderboard'),
  endedView: document.getElementById('ended-view'),
  finalLeaderboard: document.getElementById('final-leaderboard'),
  toast: document.getElementById('toast')
};

let player = null;
try {
  player = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
} catch {
  player = null;
}

let timerRaf = null;

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4000);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

el.joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.joinName.value.trim();
  if (!name) return;
  try {
    const { playerId, generation } = await postJson('/api/quiz/join', { name });
    player = { playerId, name, generation };
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
    answeredKey = '';
    lastPickedIndex = -1;
    showQuiz();
  } catch (err) {
    toast(err.message);
  }
});

function showQuiz() {
  el.joinView.hidden = true;
  el.quizView.hidden = false;
}

function showJoin() {
  player = null;
  localStorage.removeItem(PLAYER_KEY);
  el.joinView.hidden = false;
  el.quizView.hidden = true;
  el.joinName.value = '';
}

function renderOptions(container, options, { disabled = false, correctIndex = -1, myIndex = -1, counts = null } = {}) {
  container.replaceChildren();
  options.forEach((text, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option';
    if (text.length === 1) btn.classList.add('option-letter');
    btn.textContent = text;
    if (counts) {
      const total = counts.reduce((a, b) => a + b, 0) || 1;
      const pct = Math.round((counts[i] / total) * 100);
      btn.style.setProperty('--pct', pct + '%');
      btn.title = `${counts[i]} vote${counts[i] === 1 ? '' : 's'} (${pct}%)`;
    }
    if (correctIndex === i) btn.classList.add('correct');
    else if (myIndex === i && correctIndex !== -1) btn.classList.add('wrong');
    if (myIndex === i) btn.classList.add('picked');
    btn.disabled = disabled;
    if (!disabled) {
      btn.addEventListener('click', () => {
        lastPickedIndex = i;
        submitAnswer(i);
      });
    }
    container.appendChild(btn);
  });
}

async function submitAnswer(optionIndex) {
  if (!player) return;
  try {
    await postJson('/api/quiz/answer', { playerId: player.playerId, optionIndex });
    answeredKey = currentKey;
    el.answerNote.textContent = 'Answer submitted — waiting for the host to reveal…';
    renderOptions(el.options, currentOptions, { disabled: true, myIndex: optionIndex });
  } catch (err) {
    toast(err.message);
  }
}

function renderLeaderboard(list, board) {
  list.replaceChildren();
  board.forEach((entry, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${i + 1}`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = entry.score;
    li.append(rank, name, score);
    list.appendChild(li);
  });
}

let currentKey = ''; // `${roundIndex}:${questionIndex}` of the question currently shown
let answeredKey = ''; // key of the question the player has already answered
let currentOptions = [];
let lastPickedIndex = -1;

function stopTimer() {
  if (timerRaf) cancelAnimationFrame(timerRaf);
  timerRaf = null;
}

function startTimer(deadline, windowMs) {
  stopTimer();
  const tick = () => {
    const remaining = Math.max(0, deadline - Date.now());
    el.timerFill.style.width = `${(remaining / windowMs) * 100}%`;
    if (remaining > 0) timerRaf = requestAnimationFrame(tick);
  };
  tick();
}

function render(state) {
  // A reset bumps the generation on the server; a stale playerId means we've been wiped.
  if (player && state.generation !== player.generation) {
    toast('The host reset the quiz — please rejoin');
    showJoin();
    return;
  }

  el.waitingView.hidden = true;
  el.roundEndedView.hidden = true;
  el.questionView.hidden = true;
  el.revealView.hidden = true;
  el.endedView.hidden = true;

  if (state.status === 'idle') {
    el.quizStatus.textContent = '';
    el.waitingHeading.textContent = 'Waiting for the host to start the quiz…';
    el.waitingView.hidden = false;
    return;
  }

  if (state.status === 'round-ended') {
    stopTimer();
    el.quizStatus.textContent = `Round ${state.roundIndex + 1} of ${state.totalRounds} complete`;
    el.roundEndedHeading.textContent = `🎉 ${state.roundName} complete!`;
    renderLeaderboard(el.roundLeaderboard, state.leaderboard);
    el.roundEndedView.hidden = false;
    return;
  }

  if (state.status === 'ended') {
    stopTimer();
    el.quizStatus.textContent = 'Quiz complete';
    el.endedView.hidden = false;
    renderLeaderboard(el.finalLeaderboard, state.leaderboard);
    return;
  }

  el.quizStatus.textContent = `${state.roundName} · Question ${state.questionIndex + 1} of ${state.roundQuestionTotal}`;
  currentKey = `${state.roundIndex}:${state.questionIndex}`;
  currentOptions = state.question ? state.question.options : [];

  if (state.status === 'question') {
    el.questionView.hidden = false;
    el.questionText.textContent = state.question.text;
    const alreadyAnswered = answeredKey === currentKey;
    startTimer(state.deadline, state.windowMs);
    el.answerNote.textContent = alreadyAnswered
      ? 'Answer submitted — waiting for the host to reveal…'
      : `${state.answeredCount} of ${state.totalPlayers} answered`;
    renderOptions(el.options, currentOptions, { disabled: alreadyAnswered });
    return;
  }

  if (state.status === 'reveal') {
    stopTimer();
    el.revealView.hidden = false;
    el.revealHeading.textContent = state.question.text;
    const myIndex = answeredKey === currentKey ? lastPickedIndex : -1;
    renderOptions(el.revealOptions, state.question.options, {
      disabled: true,
      correctIndex: state.correctIndex,
      myIndex,
      counts: state.optionCounts
    });
    renderLeaderboard(el.leaderboard, state.leaderboard);
  }
}

function connect() {
  const source = new EventSource('/api/quiz/events');
  source.onmessage = (evt) => {
    try {
      render(JSON.parse(evt.data));
    } catch {
      // ignore malformed frame
    }
  };
  source.onerror = () => {
    // EventSource retries automatically; nothing else to do.
  };
}

if (player) showQuiz();
connect();
