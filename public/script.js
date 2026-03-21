const counter = document.getElementById('counter');
const nameInput = document.getElementById('name-input');
const button = document.getElementById('the-button');
const btnText = document.getElementById('btn-text');
const ticker = document.getElementById('ticker');
const game = document.getElementById('game');
const leaderboardPanel = document.getElementById('leaderboard');
const lbList = document.getElementById('lb-list');
const tabs = document.getElementById('tabs');
const memorial = document.getElementById('memorial');
const winnerName = document.getElementById('winner-name');
const winnerClick = document.getElementById('winner-click');
const flashOverlay = document.getElementById('flash-overlay');

// Restore name from localStorage
const savedName = localStorage.getItem('lastclick_name');
if (savedName) nameInput.value = savedName;

nameInput.addEventListener('input', () => {
  localStorage.setItem('lastclick_name', nameInput.value);
});

// --- State ---

let clicking = false;
let activeTab = 'game';
let gameBroken = false;
let lastTickerClick = 0; // track highest click# in ticker to avoid redundant re-renders

// --- API ---

async function fetchState() {
  const res = await fetch('/api/state');
  return res.json();
}

async function sendClick(name) {
  const res = await fetch('/api/click', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

async function fetchHistory() {
  const res = await fetch('/api/history');
  return res.json();
}

// --- Tabs ---

tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const target = tab.dataset.tab;
  if (target === activeTab) return;

  activeTab = target;
  tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === target));

  if (gameBroken) {
    // When broken: PLAY = memorial, LEADERBOARD = leaderboard
    memorial.hidden = target !== 'game';
    leaderboardPanel.hidden = target !== 'leaderboard';
    game.hidden = true;
  } else {
    game.hidden = target !== 'game';
    leaderboardPanel.hidden = target !== 'leaderboard';
  }

  if (target === 'leaderboard') loadLeaderboard();
});

async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    renderLeaderboard(data);
  } catch {
    lbList.innerHTML = '<div class="lb-empty">Failed to load.</div>';
  }
}

function renderLeaderboard(data) {
  if (data.length === 0) {
    lbList.innerHTML = '<div class="lb-empty">No clicks yet. Be the first.</div>';
    return;
  }
  lbList.innerHTML = data.map((entry, i) =>
    `<div class="lb-row">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${escapeHtml(entry.name)}</span>
      <span class="lb-clicks">${entry.clicks.toLocaleString()}</span>
    </div>`
  ).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Render ---

function setCounter(n) {
  counter.textContent = n.toLocaleString();
  counter.classList.add('bump');
  setTimeout(() => counter.classList.remove('bump'), 200);
}

function renderTicker(history) {
  const entries = history.slice(-10);
  const latestClick = entries.length > 0 ? entries[entries.length - 1].clickNumber : 0;

  // Skip re-render if server history is behind what we already show
  if (latestClick <= lastTickerClick && ticker.children.length > 0) return;

  // Only move forward, never backward
  if (latestClick > lastTickerClick) lastTickerClick = latestClick;

  ticker.innerHTML = '';
  // Reverse so newest entry is at the top
  [...entries].reverse().forEach(entry => {
    const el = document.createElement('div');
    el.className = 'tick-entry';
    el.textContent = `#${entry.clickNumber.toLocaleString()} — ${entry.name}`;
    ticker.appendChild(el);
  });
}

// Add a single entry to the ticker immediately (no fetch needed)
function addTickerEntry(name, clickNumber) {
  if (clickNumber <= lastTickerClick) return;
  lastTickerClick = clickNumber;

  const el = document.createElement('div');
  el.className = 'tick-entry';
  el.textContent = `#${clickNumber.toLocaleString()} — ${name}`;
  ticker.appendChild(el);

  // Trim to 10 entries
  while (ticker.children.length > 10) {
    ticker.removeChild(ticker.firstChild);
  }
}

function showMemorial(winner, clicks) {
  gameBroken = true;
  winnerName.textContent = winner.name;
  winnerClick.textContent = `Click #${clicks.toLocaleString()}`;
  game.hidden = true;

  // Show memorial on PLAY tab, leaderboard on LEADERBOARD tab
  memorial.hidden = activeTab !== 'game';
  leaderboardPanel.hidden = activeTab !== 'leaderboard';

  if (activeTab === 'leaderboard') loadLeaderboard();

  requestAnimationFrame(() => {
    memorial.classList.add('revealed');
  });
}

// --- Break sequence ---

function triggerBreak(winner, clicks) {
  // 1. Button shakes and breaks
  button.disabled = true;
  button.classList.add('breaking');

  // 2. Screen flash
  setTimeout(() => {
    flashOverlay.classList.add('flash');
  }, 800);

  // 3. Fade out game
  setTimeout(() => {
    game.classList.add('fading');
  }, 1500);

  // 4. Show memorial
  setTimeout(() => {
    game.hidden = true;
    showMemorial(winner, clicks);
  }, 2200);
}

// --- Click handler ---

button.addEventListener('click', async () => {
  if (clicking) return;

  const name = nameInput.value.trim();
  if (!name) {
    nameInput.classList.add('shake');
    nameInput.focus();
    setTimeout(() => nameInput.classList.remove('shake'), 400);
    return;
  }

  clicking = true;
  button.disabled = true;
  btnText.textContent = '...';

  try {
    const data = await sendClick(name);

    if (data.error) {
      btnText.textContent = data.error;
      setTimeout(() => {
        btnText.textContent = 'CLICK';
        button.disabled = false;
        clicking = false;
      }, 1500);
      return;
    }

    setCounter(data.clicks);

    // Update ticker from authoritative server history
    if (data.recentHistory) {
      lastTickerClick = 0; // force re-render
      renderTicker(data.recentHistory);
    }

    if (data.broken) {
      triggerBreak(data.winner, data.clicks);
      return; // No re-enable — it's over
    }

    // Success — re-enable after brief cooldown
    setTimeout(() => {
      btnText.textContent = 'CLICK';
      button.disabled = false;
      clicking = false;
    }, 300);
  } catch {
    btnText.textContent = 'ERROR';
    setTimeout(() => {
      btnText.textContent = 'CLICK';
      button.disabled = false;
      clicking = false;
    }, 2000);
  }
});

// --- Polling (keep counter + ticker live for spectators) ---

setInterval(async () => {
  try {
    const data = await fetchState();
    if (data.broken && !gameBroken) {
      triggerBreak(data.winner, data.clicks);
    } else if (!data.broken) {
      counter.textContent = data.clicks.toLocaleString();

      // Only fetch history if server is ahead of what we've seen locally
      if (data.clicks > lastTickerClick) {
        const history = await fetchHistory();
        renderTicker(history);
      }
    }
  } catch {
    // Silently fail — next poll will try again
  }
}, 5000);

// --- Init ---

// Hide game until we know the state (prevents flash of game UI when broken)
game.hidden = true;

(async () => {
  try {
    const [state, history] = await Promise.all([fetchState(), fetchHistory()]);

    if (state.broken) {
      showMemorial(state.winner, state.clicks);
    } else {
      counter.textContent = state.clicks.toLocaleString();
      game.hidden = false;
      renderTicker(history);
    }
  } catch {
    counter.textContent = '???';
    game.hidden = false;
  }
})();
