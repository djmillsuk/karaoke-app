'use strict';

const HOST_KEY_STORAGE = 'karaoke.quiz.hostkey.v1';

const el = {
  keyView: document.getElementById('key-view'),
  keyForm: document.getElementById('key-form'),
  keyInput: document.getElementById('key-input'),
  hostView: document.getElementById('host-view'),
  hostStatus: document.getElementById('host-status'),
  btnStart: document.getElementById('btn-start'),
  btnReveal: document.getElementById('btn-reveal'),
  btnNext: document.getElementById('btn-next'),
  btnEnd: document.getElementById('btn-end'),
  btnReset: document.getElementById('btn-reset'),
  hostQuestion: document.getElementById('host-question'),
  hostOptions: document.getElementById('host-options'),
  hostLeaderboard: document.getElementById('host-leaderboard'),
  changeKeyForm: document.getElementById('change-key-form'),
  newKeyInput: document.getElementById('new-key-input'),
  toast: document.getElementById('toast')
};

let hostKey = sessionStorage.getItem(HOST_KEY_STORAGE) || '';
let pollTimer = null;

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4000);
}

async function hostFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'x-quiz-host-key': hostKey }
  });
  if (res.status === 401) {
    sessionStorage.removeItem(HOST_KEY_STORAGE);
    hostKey = '';
    showKeyView('Invalid host key');
    throw new Error('Invalid host key');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function showKeyView(message) {
  el.keyView.hidden = false;
  el.hostView.hidden = true;
  stopPolling();
  if (message) toast(message);
}

function showHostView() {
  el.keyView.hidden = true;
  el.hostView.hidden = false;
}

el.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = el.keyInput.value.trim();
  if (!value) return;
  hostKey = value;
  try {
    await refresh();
    sessionStorage.setItem(HOST_KEY_STORAGE, hostKey);
    showHostView();
    startPolling();
  } catch (err) {
    toast(err.message);
  }
});

function action(name, handler) {
  handler.addEventListener('click', async () => {
    try {
      await hostFetch(`/api/quiz/host/${name}`, { method: 'POST' });
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });
}

action('start', el.btnStart);
action('reveal', el.btnReveal);
action('next', el.btnNext);
action('end', el.btnEnd);
el.btnReset.addEventListener('click', async () => {
  if (!confirm('Reset the quiz? This clears all players and scores.')) return;
  try {
    await hostFetch('/api/quiz/host/reset', { method: 'POST' });
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

el.changeKeyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const newKey = el.newKeyInput.value.trim();
  if (!newKey) return;
  try {
    await hostFetch('/api/quiz/host/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newKey })
    });
    hostKey = newKey;
    sessionStorage.setItem(HOST_KEY_STORAGE, hostKey);
    el.newKeyInput.value = '';
    toast('Host key updated');
  } catch (err) {
    toast(err.message);
  }
});

function renderOptions(options, correctIndex, counts) {
  el.hostOptions.replaceChildren();
  const total = (counts || []).reduce((a, b) => a + b, 0) || 1;
  options.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'option host-option';
    if (correctIndex === i) row.classList.add('correct');
    const pct = counts ? Math.round((counts[i] / total) * 100) : 0;
    row.style.setProperty('--pct', pct + '%');
    row.textContent = counts ? `${text} — ${counts[i]} (${pct}%)` : text;
    el.hostOptions.appendChild(row);
  });
}

function renderLeaderboard(board) {
  el.hostLeaderboard.replaceChildren();
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
    el.hostLeaderboard.appendChild(li);
  });
}

function updateButtons(state) {
  el.btnStart.disabled = state.status === 'question' || state.status === 'reveal';
  el.btnReveal.disabled = state.status !== 'question';
  el.btnNext.disabled = state.status === 'idle';
  el.btnEnd.disabled = state.status === 'idle' || state.status === 'ended';
}

async function refresh() {
  const state = await hostFetch('/api/quiz/host/state');
  el.hostStatus.textContent = `${state.status.toUpperCase()} · ${state.totalPlayers} player${state.totalPlayers === 1 ? '' : 's'}` +
    (state.index >= 0 ? ` · question ${state.index + 1} of ${state.total} · ${state.answeredCount} answered` : '');
  el.hostQuestion.textContent = state.question ? state.question.text : 'No question shown yet';
  if (state.question) {
    renderOptions(state.question.options, state.correctIndex, state.optionCounts);
  } else {
    el.hostOptions.replaceChildren();
  }
  renderLeaderboard(state.leaderboard || []);
  updateButtons(state);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => refresh().catch((err) => toast(err.message)), 1500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

(async function init() {
  if (!hostKey) return showKeyView();
  try {
    await refresh();
    showHostView();
    startPolling();
  } catch {
    showKeyView();
  }
})();
