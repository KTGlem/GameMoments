'use strict';

/* ============================================================
   GameMoments — app.js
   One-tap soccer event logger. All data stored in IndexedDB.
   No backend. Works fully offline.
   ============================================================ */


/* ─────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────── */

const DB_NAME    = 'GameMomentsDB';
const DB_VERSION = 1;
const STORE_GAMES  = 'games';
const STORE_EVENTS = 'events';

/** Event type definitions — drives the button grid */
const EVENT_TYPES = [
  { code: 'GK',   label: 'GOAL KICK', isGoal: false },
  { code: 'CK',   label: 'CORNER',    isGoal: false },
  { code: 'FK',   label: 'FREE KICK', isGoal: false },
  { code: 'KO',   label: 'KICKOFF',   isGoal: false },
  { code: 'SO',   label: 'SIDEOUT',   isGoal: false },
  { code: 'GOAL', label: 'GOAL',      isGoal: true  },
];

/** Human-readable labels for each event code */
const EVENT_DISPLAY = {
  GK_PFC:   'Goal Kick — PFC',
  GK_OPP:   'Goal Kick — Opponent',
  CK_PFC:   'Corner — PFC',
  CK_OPP:   'Corner — Opponent',
  FK_PFC:   'Free Kick — PFC',
  FK_OPP:   'Free Kick — Opponent',
  KO_PFC:   'Kickoff — PFC',
  KO_OPP:   'Kickoff — Opponent',
  SO_PFC:   'Sideout — PFC',
  SO_OPP:   'Sideout — Opponent',
  GOAL_PFC: 'Goal — PFC',
  GOAL_OPP: 'Goal — Opponent',
};

/** Event code → CSS class for coloring */
const EVENT_CLASS = (code) => {
  if (code.startsWith('GOAL')) return 'ev-goal';
  if (code.endsWith('_PFC'))  return 'ev-pfc';
  return 'ev-opp';
};


/* ─────────────────────────────────────────────
   STATE
───────────────────────────────────────────── */

let db           = null;   // IndexedDB connection
let currentGame  = null;   // Active game object
let currentEvents = [];    // Events for current game (in memory)
let currentHalf  = 1;      // 1 or 2
let clockSeconds = 0;      // Elapsed seconds in current half
let clockInterval = null;  // setInterval handle
let wakeLock     = null;   // WakeLock sentinel
let gameActive   = false;  // True while a session is live


/* ─────────────────────────────────────────────
   INITIALISE
───────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  db = await openDB();
  buildEventGrid();
  attachListeners();
  generateAppleTouchIcon();
  registerServiceWorker();
  showScreen('setup');
});


/* ─────────────────────────────────────────────
   SERVICE WORKER
───────────────────────────────────────────── */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js')
      .then(() => console.log('SW: registered'))
      .catch((err) => console.warn('SW: registration failed', err));
  }
}


/* ─────────────────────────────────────────────
   INDEXEDDB
───────────────────────────────────────────── */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_GAMES)) {
        idb.createObjectStore(STORE_GAMES, { keyPath: 'game_id' });
      }
      if (!idb.objectStoreNames.contains(STORE_EVENTS)) {
        const evStore = idb.createObjectStore(STORE_EVENTS, { keyPath: 'event_id' });
        // Index lets us efficiently fetch all events for a given game
        evStore.createIndex('by_game', 'game_id', { unique: false });
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/** Write (insert or update) a single record */
function dbPut(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(data);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** Read all records from a store */
function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Read all events for a specific game_id using the index */
function dbGetEventsByGame(gameId) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_EVENTS, 'readonly');
    const index = tx.objectStore(STORE_EVENTS).index('by_game');
    const req   = index.getAll(gameId);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Delete a single record by key */
function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}


/* ─────────────────────────────────────────────
   SCREEN MANAGEMENT
───────────────────────────────────────────── */

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}


/* ─────────────────────────────────────────────
   EVENT GRID BUILDER
   Runs once on init; buttons are reused throughout the session.
───────────────────────────────────────────── */

function buildEventGrid() {
  const grid = document.getElementById('event-grid');
  grid.innerHTML = '';

  EVENT_TYPES.forEach(({ code, label, isGoal }) => {
    const row = document.createElement('div');
    row.className = 'event-row' + (isGoal ? ' event-row-goal' : '');

    // Left label
    const lbl = document.createElement('div');
    lbl.className   = 'event-row-label';
    lbl.textContent = label;

    // PFC button
    const btnPFC = document.createElement('button');
    btnPFC.className        = 'btn-event btn-pfc';
    btnPFC.dataset.code     = `${code}_PFC`;
    btnPFC.textContent      = 'PFC';
    btnPFC.setAttribute('aria-label', EVENT_DISPLAY[`${code}_PFC`]);
    btnPFC.addEventListener('click', () => logEvent(`${code}_PFC`));

    // OPP button
    const btnOPP = document.createElement('button');
    btnOPP.className        = 'btn-event btn-opp';
    btnOPP.dataset.code     = `${code}_OPP`;
    btnOPP.textContent      = 'OPP';
    btnOPP.setAttribute('aria-label', EVENT_DISPLAY[`${code}_OPP`]);
    btnOPP.addEventListener('click', () => logEvent(`${code}_OPP`));

    row.appendChild(lbl);
    row.appendChild(btnPFC);
    row.appendChild(btnOPP);
    grid.appendChild(row);
  });
}


/* ─────────────────────────────────────────────
   DOM EVENT LISTENERS
───────────────────────────────────────────── */

function attachListeners() {
  // Setup screen
  document.getElementById('btn-start').addEventListener('click', startGame);
  document.getElementById('btn-view-games').addEventListener('click', viewSavedGames);

  // Logging screen
  document.getElementById('btn-undo').addEventListener('click', undoLastEvent);
  document.getElementById('btn-half2').addEventListener('click', startHalf2);
  document.getElementById('btn-end-game').addEventListener('click', endGame);

  // Review screen
  document.getElementById('btn-back-to-setup').addEventListener('click', () => {
    if (gameActive) {
      if (!confirm('Start a new game? The current session will be saved.')) return;
      stopClock();
      releaseWakeLock();
      gameActive = false;
    }
    showScreen('setup');
  });

  document.getElementById('btn-resume-logging').addEventListener('click', () => {
    updateScoreboard();  // re-sync score display before the logging screen appears
    showScreen('logging');
    // If clock was paused (game was ended but user resumed), restart it
    if (!clockInterval && gameActive) startClock();
  });

  // Filters
  ['filter-half', 'filter-team', 'filter-type'].forEach((id) => {
    document.getElementById(id).addEventListener('change', renderEventsList);
  });

  // Export
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-export-text').addEventListener('click', exportText);

  // Time adjust
  document.getElementById('btn-apply-adjust').addEventListener('click', applyTimeAdjust);

  // Saved games screen
  document.getElementById('btn-back-from-games').addEventListener('click', () => showScreen('setup'));
  document.getElementById('btn-new-game-from-list').addEventListener('click', () => showScreen('setup'));

  // Re-acquire wake lock if the app comes back into view while a game is live
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gameActive) {
      requestWakeLock();
    }
  });
}


/* ─────────────────────────────────────────────
   SETUP — START GAME
───────────────────────────────────────────── */

async function startGame() {
  const opponent   = document.getElementById('input-opponent').value.trim() || 'Unknown';
  const loggerName = document.getElementById('input-logger').value.trim()   || 'Logger 1';

  currentGame = {
    game_id:     `game_${Date.now()}`,
    date:        new Date().toISOString(),
    opponent,
    logger_name: loggerName,
  };

  await dbPut(STORE_GAMES, currentGame);

  // Reset session state
  currentEvents = [];
  currentHalf   = 1;
  clockSeconds  = 0;
  gameActive    = true;

  // Reset UI
  document.getElementById('half-indicator').textContent   = 'HALF 1';
  document.getElementById('header-opponent').textContent  = `vs ${opponent}`;
  document.getElementById('btn-half2').classList.add('hidden');
  document.getElementById('btn-end-game').classList.add('hidden');
  document.getElementById('btn-resume-logging').classList.add('hidden');

  // Set scoreboard opponent label (truncated for the narrow HUD column)
  document.getElementById('score-opp-name').textContent =
    (opponent || 'OPP').slice(0, 8).toUpperCase();
  updateScoreboard();  // currentEvents is [] here, so displays 0 – 0

  updateClock();
  updateRecentEvents();
  startClock();
  requestWakeLock();
  showScreen('logging');
}


/* ─────────────────────────────────────────────
   CLOCK
───────────────────────────────────────────── */

function startClock() {
  stopClock(); // Prevent double-interval
  clockInterval = setInterval(() => {
    clockSeconds++;
    updateClock();
  }, 1000);
}

function stopClock() {
  if (clockInterval) {
    clearInterval(clockInterval);
    clockInterval = null;
  }
}

function updateClock() {
  document.getElementById('clock').textContent = formatTime(clockSeconds);
}

/** Convert integer seconds to mm:ss string */
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const r = (s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}


/* ─────────────────────────────────────────────
   SCOREBOARD
───────────────────────────────────────────── */

/**
 * Recompute PFC and OPP goal counts from currentEvents and write them
 * to the score HUD. Called after every logEvent(), undoLastEvent(),
 * startGame(), and resume. No separate score state is maintained —
 * events are always the single source of truth, so undo, load, and
 * time-adjust are all automatically correct.
 */
function updateScoreboard() {
  let pfc = 0, opp = 0;
  for (const e of currentEvents) {
    if      (e.event_code === 'GOAL_PFC') pfc++;
    else if (e.event_code === 'GOAL_OPP') opp++;
  }
  document.getElementById('score-pfc').textContent = pfc;
  document.getElementById('score-opp').textContent = opp;
}


/* ─────────────────────────────────────────────
   EVENT LOGGING
───────────────────────────────────────────── */

async function logEvent(eventCode) {
  if (!currentGame || !gameActive) return;

  const event = {
    event_id:       `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    game_id:        currentGame.game_id,
    half:           currentHalf,
    t_half_seconds: clockSeconds,
    event_code:     eventCode,
    created_at:     new Date().toISOString(),
  };

  currentEvents.push(event);
  await dbPut(STORE_EVENTS, event);

  // Visual + haptic feedback
  flashButton(eventCode);
  vibrate();

  // Goals get a special full-screen flash
  if (eventCode.startsWith('GOAL')) goalCelebration();

  updateRecentEvents();
  updateScoreboard();

  // Reveal half-transition buttons after first event
  if (currentHalf === 1) {
    document.getElementById('btn-half2').classList.remove('hidden');
  }
  if (currentHalf === 2) {
    document.getElementById('btn-end-game').classList.remove('hidden');
  }
}

/** Remove the most recently logged event */
async function undoLastEvent() {
  if (!currentEvents.length) {
    showToast('Nothing to undo');
    return;
  }

  const last = currentEvents.pop();
  await dbDelete(STORE_EVENTS, last.event_id);

  updateRecentEvents();
  updateScoreboard();
  vibrate(30);
  showToast('Event removed');
}

/** Briefly fill a button with its team colour */
function flashButton(eventCode) {
  const btn = document.querySelector(`[data-code="${eventCode}"]`);
  if (!btn) return;
  btn.classList.add('flash');
  btn.addEventListener('animationend', () => btn.classList.remove('flash'), { once: true });
}

/** Brief full-screen gold flash for GOAL events */
function goalCelebration() {
  // Create overlay if it doesn't exist
  let overlay = document.getElementById('goal-flash');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'goal-flash';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('show');
  setTimeout(() => overlay.classList.remove('show'), 400);
  vibrate([80, 40, 80]); // Double buzz for goals
}

/** Short haptic feedback — degrades gracefully where unsupported */
function vibrate(pattern = 45) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (_) { /* ignore */ }
  }
}


/* ─────────────────────────────────────────────
   RECENT EVENTS DISPLAY (last 3 in footer)
───────────────────────────────────────────── */

function updateRecentEvents() {
  const container = document.getElementById('recent-events');
  const last3     = currentEvents.slice(-3).reverse();

  if (!last3.length) {
    container.innerHTML = '<div class="recent-placeholder">— tap an event to log it —</div>';
    return;
  }

  container.innerHTML = last3.map((e) => {
    const cls = EVENT_CLASS(e.event_code);
    return `
      <div class="recent-event ${cls.replace('ev-', 're-')}">
        <span class="re-half">H${e.half}</span>
        <span class="re-time">${formatTime(e.t_half_seconds)}</span>
        <span class="re-label">${EVENT_DISPLAY[e.event_code] || e.event_code}</span>
      </div>`;
  }).join('');
}


/* ─────────────────────────────────────────────
   HALF TRANSITIONS
───────────────────────────────────────────── */

function startHalf2() {
  stopClock();
  currentHalf  = 2;
  clockSeconds = 0;

  document.getElementById('half-indicator').textContent = 'HALF 2';
  document.getElementById('btn-half2').classList.add('hidden');
  document.getElementById('btn-end-game').classList.remove('hidden');

  updateClock();
  updateRecentEvents();
  startClock();
  showToast('HALF 2 STARTED');
}

function endGame() {
  stopClock();
  releaseWakeLock();
  gameActive = false;

  // Show resume button on review so user can go back if needed
  document.getElementById('btn-resume-logging').classList.remove('hidden');

  openReviewScreen();
  showScreen('review');
}


/* ─────────────────────────────────────────────
   REVIEW SCREEN
───────────────────────────────────────────── */

function openReviewScreen() {
  if (!currentGame) return;

  const date = new Date(currentGame.date).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric'
  });

  // Derive score from events — works for live sessions and loaded saved games
  const pfcGoals = currentEvents.filter((e) => e.event_code === 'GOAL_PFC').length;
  const oppGoals = currentEvents.filter((e) => e.event_code === 'GOAL_OPP').length;

  document.getElementById('review-game-info').innerHTML = `
    <span class="ri-opp">vs ${esc(currentGame.opponent)}</span>
    <span class="ri-score">${pfcGoals} – ${oppGoals}</span>
    <span class="ri-date">${esc(date)}</span>
    <span class="ri-logger">${esc(currentGame.logger_name)}</span>
  `;

  // Reset filters
  document.getElementById('filter-half').value = 'all';
  document.getElementById('filter-team').value = 'all';
  document.getElementById('filter-type').value = 'all';

  // Reset time adjust
  document.getElementById('adjust-h1').value = '0';
  document.getElementById('adjust-h2').value = '0';

  renderEventsList();
}

function getFilteredEvents() {
  const half = document.getElementById('filter-half').value;
  const team = document.getElementById('filter-team').value;
  const type = document.getElementById('filter-type').value;

  return currentEvents.filter((e) => {
    if (half !== 'all' && e.half !== parseInt(half, 10)) return false;
    if (team !== 'all' && !e.event_code.endsWith(`_${team}`)) return false;
    if (type !== 'all' && !e.event_code.startsWith(type)) return false;
    return true;
  });
}

function renderEventsList() {
  const events  = getFilteredEvents();
  const list    = document.getElementById('events-list');

  if (!events.length) {
    list.innerHTML = '<div class="no-events">No events match this filter</div>';
    return;
  }

  list.innerHTML = events.map((e) => {
    const cls = EVENT_CLASS(e.event_code);
    return `
      <div class="event-item ${cls}">
        <span class="ev-half">H${e.half}</span>
        <span class="ev-time">${formatTime(e.t_half_seconds)}</span>
        <span class="ev-label">${esc(EVENT_DISPLAY[e.event_code] || e.event_code)}</span>
      </div>`;
  }).join('');
}

/** Offset event times to correct drift against video footage */
async function applyTimeAdjust() {
  const adjH1 = parseInt(document.getElementById('adjust-h1').value, 10) || 0;
  const adjH2 = parseInt(document.getElementById('adjust-h2').value, 10) || 0;

  if (adjH1 === 0 && adjH2 === 0) {
    showToast('No adjustment entered');
    return;
  }

  currentEvents = currentEvents.map((e) => {
    const adj    = e.half === 1 ? adjH1 : adjH2;
    const newSec = Math.max(0, e.t_half_seconds + adj);
    return { ...e, t_half_seconds: newSec };
  });

  // Persist adjusted events
  await Promise.all(currentEvents.map((e) => dbPut(STORE_EVENTS, e)));

  document.getElementById('adjust-h1').value = '0';
  document.getElementById('adjust-h2').value = '0';

  renderEventsList();
  showToast('Times adjusted');
}


/* ─────────────────────────────────────────────
   EXPORT
───────────────────────────────────────────── */

function eventToDisplayLine(e) {
  return `H${e.half} ${formatTime(e.t_half_seconds)} ${EVENT_DISPLAY[e.event_code] || e.event_code}`;
}

function exportCSV() {
  const events = getFilteredEvents();
  if (!events.length) { showToast('No events to export'); return; }

  const date   = new Date(currentGame.date).toLocaleDateString();
  const header = ['Date', 'Opponent', 'Logger', 'Half', 'Time (mm:ss)', 'Seconds', 'Event'];
  const rows   = events.map((e) => [
    date,
    currentGame.opponent,
    currentGame.logger_name,
    `H${e.half}`,
    formatTime(e.t_half_seconds),
    e.t_half_seconds,
    EVENT_DISPLAY[e.event_code] || e.event_code,
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  downloadFile(csv, buildFilename('csv'), 'text/csv;charset=utf-8;');
}

function exportText() {
  const events = getFilteredEvents();
  if (!events.length) { showToast('No events to export'); return; }

  const date = new Date(currentGame.date).toLocaleDateString();
  const lines = [
    'GameMoments Export',
    `Date:     ${date}`,
    `Opponent: ${currentGame.opponent}`,
    `Logger:   ${currentGame.logger_name}`,
    '',
    ...events.map(eventToDisplayLine),
  ];

  downloadFile(lines.join('\n'), buildFilename('txt'), 'text/plain;charset=utf-8;');
}

function buildFilename(ext) {
  const date = new Date(currentGame.date).toISOString().slice(0, 10);
  const opp  = currentGame.opponent.replace(/[^a-z0-9]/gi, '_').slice(0, 20);
  return `GameMoments_${date}_${opp}.${ext}`;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


/* ─────────────────────────────────────────────
   SAVED GAMES LIST
───────────────────────────────────────────── */

async function viewSavedGames() {
  let games = await dbGetAll(STORE_GAMES);

  // Sort newest first
  games.sort((a, b) => new Date(b.date) - new Date(a.date));

  const listEl = document.getElementById('games-list');

  if (!games.length) {
    listEl.innerHTML = '<div class="no-events" style="padding:32px">No saved games yet</div>';
    showScreen('games');
    return;
  }

  // For each game, fetch event count asynchronously
  const eventCounts = await Promise.all(
    games.map((g) => dbGetEventsByGame(g.game_id).then((evs) => evs.length))
  );

  listEl.innerHTML = games.map((g, i) => {
    const date  = new Date(g.date).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric'
    });
    return `
      <div class="game-item" data-id="${esc(g.game_id)}">
        <div class="gi-main">
          <span class="gi-opp">vs ${esc(g.opponent)}</span>
          <span class="gi-date">${esc(date)}</span>
        </div>
        <div class="gi-sub">${esc(g.logger_name)}</div>
        <div class="gi-count">${eventCounts[i]} event${eventCounts[i] !== 1 ? 's' : ''} logged</div>
      </div>`;
  }).join('');

  // Tap a game → load it into review screen
  listEl.querySelectorAll('.game-item').forEach((item) => {
    item.addEventListener('click', () => loadSavedGame(item.dataset.id));
  });

  showScreen('games');
}

async function loadSavedGame(gameId) {
  const games = await dbGetAll(STORE_GAMES);
  currentGame = games.find((g) => g.game_id === gameId);
  if (!currentGame) return;

  currentEvents = await dbGetEventsByGame(gameId);
  // Sort chronologically: H1 before H2, then by time within half
  currentEvents.sort((a, b) => {
    if (a.half !== b.half) return a.half - b.half;
    return a.t_half_seconds - b.t_half_seconds;
  });

  // Loading a saved game doesn't start a live session
  gameActive = false;
  document.getElementById('btn-resume-logging').classList.add('hidden');

  openReviewScreen();
  showScreen('review');
}


/* ─────────────────────────────────────────────
   WAKE LOCK  (keeps screen on during logging)
   Degrades gracefully — iOS Safari has limited support.
───────────────────────────────────────────── */

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    console.log('Wake lock acquired');
  } catch (err) {
    // Permission denied or not available — no action needed
    console.log('Wake lock unavailable:', err.message);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}


/* ─────────────────────────────────────────────
   TOAST NOTIFICATIONS
───────────────────────────────────────────── */

let toastTimeout = null;

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 1800);
}


/* ─────────────────────────────────────────────
   APPLE TOUCH ICON (Canvas-generated PNG)
   Generates a proper PNG icon for iOS Add to Home Screen.
   The SVG in the manifest covers Android/Chrome.
───────────────────────────────────────────── */

function generateAppleTouchIcon() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = 192;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background
    ctx.fillStyle = '#0d0d1a';
    ctx.roundRect
      ? ctx.roundRect(0, 0, 192, 192, 28)
      : ctx.rect(0, 0, 192, 192);
    ctx.fill();

    // Outer border
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth   = 5;
    ctx.strokeRect(8, 8, 176, 176);

    // "GM" text
    ctx.fillStyle   = '#00e5ff';
    ctx.font        = 'bold 80px Arial Black, Arial';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GM', 96, 90);

    // Dot row
    ctx.fillStyle = 'rgba(0,229,255,0.55)';
    [60, 96, 132].forEach((x) => {
      ctx.beginPath();
      ctx.arc(x, 155, 7, 0, Math.PI * 2);
      ctx.fill();
    });

    const link = document.getElementById('apple-touch-icon');
    if (link) link.href = canvas.toDataURL('image/png');
  } catch (_) {
    // Canvas may be blocked in some environments — SVG fallback remains
  }
}


/* ─────────────────────────────────────────────
   UTILITY
───────────────────────────────────────────── */

/** Simple HTML escaping to prevent XSS when inserting user data into innerHTML */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}
