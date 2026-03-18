import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MAX_CLICKS, PORT, ADMIN_SECRET } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const INITIAL_STATE = {
  clicks: 0,
  broken: false,
  winner: null,
  history: [],
  leaderboard: {},
};

// --- Persistence ---

function loadState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(INITIAL_STATE, null, 2));
    return { ...INITIAL_STATE, history: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// --- Mutex (serialize clicks) ---

let lock = Promise.resolve();
function withLock(fn) {
  const next = lock.then(fn, fn);
  lock = next;
  return next;
}

// --- Rate limiter (1 click/sec per IP) ---

const lastClick = new Map();
const RATE_LIMIT_MS = 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const last = lastClick.get(ip);
  if (last && now - last < RATE_LIMIT_MS) return true;
  lastClick.set(ip, now);
  return false;
}

// Clean up rate limit map every 60s
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_MS * 2;
  for (const [ip, time] of lastClick) {
    if (time < cutoff) lastClick.delete(ip);
  }
}, 60000);

// --- Profanity filter ---

const BLOCKED_WORDS = new Set([
  'fuck', 'shit', 'ass', 'asshole', 'bitch', 'bastard', 'damn', 'dick',
  'cock', 'cunt', 'pussy', 'whore', 'slut', 'fag', 'faggot', 'nigger',
  'nigga', 'retard', 'retarded', 'twat', 'wanker', 'prick', 'douche',
  'jackass', 'motherfucker', 'bullshit', 'horseshit', 'dipshit', 'shithead',
  'dumbass', 'fatass', 'badass', 'arsehole', 'bollocks', 'bugger', 'sodoff',
  'tits', 'boobs', 'penis', 'vagina', 'anus', 'dildo', 'jizz', 'cum',
  'rape', 'rapist', 'molest', 'pedo', 'pedophile', 'nazi', 'hitler',
  'kike', 'spic', 'chink', 'wetback', 'beaner', 'gook', 'cracker',
]);

function containsProfanity(name) {
  const lower = name.toLowerCase().replace(/[^a-z]/g, ' ');
  const words = lower.split(/\s+/);
  for (const word of words) {
    if (BLOCKED_WORDS.has(word)) return true;
  }
  // Also check the full string without spaces/special chars for evasion like "f u c k"
  const compressed = lower.replace(/\s+/g, '');
  for (const bad of BLOCKED_WORDS) {
    if (bad.length >= 4 && compressed.includes(bad)) return true;
  }
  return false;
}

// --- Sanitize ---

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/<[^>]*>/g, '').trim().slice(0, 40);
  return name.length > 0 ? name : null;
}

// --- Express ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Public state (never reveals MAX_CLICKS)
app.get('/api/state', (_req, res) => {
  res.json({
    clicks: state.clicks,
    broken: state.broken,
    winner: state.winner,
  });
});

// Recent click history
app.get('/api/history', (_req, res) => {
  res.json(state.history);
});

// Leaderboard (top 20 clickers)
app.get('/api/leaderboard', (_req, res) => {
  const lb = state.leaderboard || {};
  const sorted = Object.entries(lb)
    .map(([name, clicks]) => ({ name, clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 20);
  res.json(sorted);
});

// The click
app.post('/api/click', (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too fast. Breathe.' });
  }

  const name = sanitizeName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  if (containsProfanity(name)) {
    return res.status(400).json({ error: 'Keep it clean.' });
  }

  withLock(async () => {
    if (state.broken) {
      return res.json({
        clicks: state.clicks,
        broken: true,
        winner: state.winner,
        yourClick: null,
      });
    }

    state.clicks += 1;
    const clickNumber = state.clicks;

    // Track leaderboard
    if (!state.leaderboard) state.leaderboard = {};
    state.leaderboard[name] = (state.leaderboard[name] || 0) + 1;

    // Push to history (keep last 50)
    state.history.push({ name, clickNumber, timestamp: new Date().toISOString() });
    if (state.history.length > 50) state.history.shift();

    // Check if this is THE click
    if (state.clicks >= MAX_CLICKS) {
      state.broken = true;
      state.winner = { name, timestamp: new Date().toISOString() };
    }

    saveState();

    res.json({
      clicks: state.clicks,
      broken: state.broken,
      winner: state.winner,
      yourClick: clickNumber,
      recentHistory: state.history.slice(-10),
    });
  });
});

// --- Admin ---

// Remove a name from history + leaderboard
// POST /api/admin/remove { secret, name }
app.post('/api/admin/remove', (req, res) => {
  const { secret, name } = req.body || {};

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  withLock(async () => {
    const lowerName = name.toLowerCase();

    // Remove from history
    const beforeHistory = state.history.length;
    state.history = state.history.filter(
      (entry) => entry.name.toLowerCase() !== lowerName
    );
    const removedHistory = beforeHistory - state.history.length;

    // Remove from leaderboard and subtract from total clicks
    let removedLeaderboard = 0;
    if (state.leaderboard) {
      for (const key of Object.keys(state.leaderboard)) {
        if (key.toLowerCase() === lowerName) {
          removedLeaderboard += state.leaderboard[key];
          delete state.leaderboard[key];
        }
      }
    }

    // Subtract removed clicks from total count
    state.clicks = Math.max(0, state.clicks - removedLeaderboard);

    saveState();

    res.json({
      removed: {
        historyEntries: removedHistory,
        leaderboardClicks: removedLeaderboard,
      },
      currentClicks: state.clicks,
    });
  });
});

// Reset the entire game
// POST /api/admin/reset { secret }
app.post('/api/admin/reset', (req, res) => {
  const { secret } = req.body || {};

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  withLock(async () => {
    state = { ...INITIAL_STATE, history: [], leaderboard: {} };
    saveState();
    res.json({ message: 'Game reset.', state });
  });
});

app.listen(PORT, () => {
  console.log(`The Last Click is live on http://localhost:${PORT}`);
  console.log(`Secret limit: ${MAX_CLICKS} clicks`);
  console.log(`Current state: ${state.clicks} clicks, broken: ${state.broken}`);
});
