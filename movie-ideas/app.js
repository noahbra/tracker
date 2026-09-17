// UI for the movie-idea slot machine. Pure logic lives in logic.js; this
// file renders the reels, runs the spin animation, calls Claude for the
// logline (or the house generator without a key), and keeps history.

import * as M from './logic.js';

const KEYS = { key: 'movie-ideas.key', history: 'movie-ideas.history', held: 'movie-ideas.held' };
const STRIP_LENGTH = 34;      // cells a reel scrolls through per spin
const BASE_MS = 1700;         // first reel's travel time
const STAGGER_MS = 550;       // each later reel stops this much later
const HISTORY_MAX = 40;

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const el = {
  reels: $('reels'), spin: $('spin'), status: $('idea-status'), title: $('idea-title'), line: $('idea-line'),
  actions: $('idea-actions'), reroll: $('reroll'), copy: $('copy'),
  history: $('history'), historySection: $('history-section'), clearHistory: $('clear-history'),
  settingsBtn: $('settings-btn'), settings: $('settings'), apiKey: $('api-key'), saveKey: $('save-key'),
};

// ---------- state ----------

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('save failed', e); }
}

const state = {
  current: {},                 // { genre, character, style } on screen now
  held: load(KEYS.held, {}),   // { reelKey: true }
  history: load(KEYS.history, []),
  spinning: false,
  seq: 0,                      // bumps per spin so a stale reply cannot land on a newer spin
};

// ---------- reels ----------

const reelEls = {};

function buildReels() {
  for (const reel of M.REELS) {
    const root = document.createElement('div');
    root.className = 'reel';
    root.dataset.key = reel.key;
    root.innerHTML = `
      <button class="reel-label" type="button" aria-pressed="false">${reel.label}<span class="tag">HELD</span></button>
      <div class="window"><div class="strip"></div></div>`;
    const label = root.querySelector('.reel-label');
    label.addEventListener('click', () => toggleHold(reel.key));
    el.reels.appendChild(root);
    reelEls[reel.key] = { root, strip: root.querySelector('.strip'), label };
  }
}

function rowHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 72;
}

// Renders a strip of cells; `winIndex` is the cell that sits in the marker.
function renderStrip(reelKey, cells, winIndex) {
  const { strip } = reelEls[reelKey];
  strip.innerHTML = cells
    .map((text, i) => `<div class="cell${i === winIndex ? ' win' : ''}">${escapeHtml(text)}</div>`)
    .join('');
}

// The three cells currently visible in the window, read back from the DOM.
function visibleCells(reelKey) {
  const cells = [...reelEls[reelKey].strip.querySelectorAll('.cell')].map((c) => c.textContent);
  if (cells.length < 3) return cells;
  const win = cells.findIndex((_, i) => reelEls[reelKey].strip.children[i].classList.contains('win'));
  const start = Math.max(0, win - 1);
  return cells.slice(start, start + 3);
}

function setHeld(reelKey, held) {
  state.held[reelKey] = !!held;
  save(KEYS.held, state.held);
  const { root, label } = reelEls[reelKey];
  root.classList.toggle('held', !!held);
  label.setAttribute('aria-pressed', held ? 'true' : 'false');
}

function toggleHold(reelKey) {
  if (state.spinning || !state.current[reelKey]) return;
  setHeld(reelKey, !state.held[reelKey]);
}

// Initial fill: a random cell in the marker with a neighbour above and below.
function fillIdle() {
  state.current = M.spin({}, {});
  for (const reel of M.REELS) {
    const t = state.current[reel.key];
    const above = M.pickOne(reel.items, Math.random, t);
    const below = M.pickOne(reel.items, Math.random, t);
    renderStrip(reel.key, [above, t, below], 1);
    reelEls[reel.key].strip.style.transform = 'translate3d(0,0,0)';
    reelEls[reel.key].root.classList.add('landed');
  }
}

// Scrolls one reel to `target`. Resolves when it stops.
function animateReel(reel, target, durationMs) {
  const { strip, root } = reelEls[reel.key];
  const h = rowHeight();
  const visible = visibleCells(reel.key);
  const cells = M.buildStrip(reel.items, visible, target, STRIP_LENGTH);
  const winIndex = cells.length - 2;
  root.classList.remove('landed');
  strip.classList.remove('moving');
  renderStrip(reel.key, cells, winIndex);
  strip.style.transform = 'translate3d(0,0,0)';
  strip.getBoundingClientRect(); // commit the start position before transitioning
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      strip.removeEventListener('transitionend', finish);
      root.classList.add('landed');
      resolve();
    };
    strip.addEventListener('transitionend', finish);
    strip.style.setProperty('--dur', `${durationMs}ms`);
    strip.classList.add('moving');
    strip.style.transform = `translate3d(0, ${-(winIndex - 1) * h}px, 0)`;
    setTimeout(finish, durationMs + 200); // belt and braces if transitionend never fires
  });
}

// ---------- spin ----------

async function doSpin() {
  if (state.spinning) return;
  state.spinning = true;
  state.seq++;
  const seq = state.seq;
  el.spin.disabled = true;
  el.reroll.disabled = true;
  el.actions.hidden = true;
  el.title.textContent = '';
  el.line.textContent = '';
  setStatus('Spinning');

  const next = M.spin(state.current, state.held);
  const runs = [];
  let i = 0;
  for (const reel of M.REELS) {
    if (state.held[reel.key] && state.current[reel.key]) continue;
    const dur = reduced ? 250 : BASE_MS + i * STAGGER_MS;
    runs.push(animateReel(reel, next[reel.key], dur));
    i++;
  }
  await Promise.all(runs);
  state.current = next;
  state.spinning = false;
  el.spin.disabled = false;
  await generate(seq);
}

// ---------- logline ----------

function setStatus(text, thinking = false) {
  el.status.textContent = text;
  el.status.classList.toggle('thinking', thinking);
}

async function generate(seq) {
  const pick = { ...state.current };
  const key = getKey();
  let result;
  if (key) {
    setStatus('Asking Claude', true);
    try {
      result = await askClaude(pick, key);
      result.source = 'claude';
    } catch (e) {
      console.warn('logline request failed', e);
      result = { ...house(pick), source: 'house', note: shortError(e) };
    }
  } else {
    result = { ...house(pick), source: 'house' };
  }
  if (seq !== state.seq) return; // a newer spin has started; drop this one
  showIdea(result);
  pushHistory({ ...pick, title: result.title, logline: result.logline, source: result.source, at: Date.now() });
}

function house(pick) {
  return { title: M.houseTitle(pick), logline: M.houseLogline(pick) };
}

async function askClaude(pick, key) {
  const res = await fetch(M.API_URL, {
    method: 'POST',
    headers: M.requestHeaders(key),
    body: JSON.stringify(M.buildRequest(pick)),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error && j.error.message) msg = `${res.status}: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  return M.parseResponse(await res.json());
}

function shortError(e) {
  const m = String(e && e.message || e);
  if (/401|authentication/i.test(m)) return 'Key rejected. House logline instead.';
  if (/429|rate/i.test(m)) return 'Rate limited. House logline instead.';
  if (/declined/i.test(m)) return 'Claude declined this one. House logline instead.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Offline. House logline instead.';
  return 'Claude unavailable. House logline instead.';
}

function showIdea(result) {
  const combo = `${state.current.genre} · ${state.current.character} · ${state.current.style}`;
  setStatus(result.note || (result.source === 'claude' ? combo : `${combo} · house logline`));
  el.title.textContent = result.title || '';
  el.line.textContent = result.logline;
  el.actions.hidden = false;
  el.reroll.disabled = false;
}

// ---------- history ----------

function pushHistory(entry) {
  state.history.unshift(entry);
  state.history.length = Math.min(state.history.length, HISTORY_MAX);
  save(KEYS.history, state.history);
  renderHistory();
}

function renderHistory() {
  const items = state.history.slice(1); // the newest is on screen already
  el.historySection.hidden = items.length === 0;
  el.history.innerHTML = items.map((h, i) => `
    <li>
      <div class="combo"><b>${escapeHtml(h.genre)}</b> · <b>${escapeHtml(h.character)}</b> · <b>${escapeHtml(h.style)}</b>${h.source === 'house' ? ' · house' : ''}</div>
      ${h.title ? `<div class="t">${escapeHtml(h.title)}</div>` : ''}
      <div class="l">${escapeHtml(h.logline)}</div>
      <div class="actions">
        <button class="ghost" data-copy="${i + 1}">Copy</button>
        <button class="ghost" data-reload="${i + 1}">Load reels</button>
      </div>
    </li>`).join('');
}

function ideaText(h) {
  return `${h.title ? h.title + '\n' : ''}${h.logline}\n(${h.genre} / ${h.character} / ${h.style})`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Select & copy');
  }
}

function flash(button, text) {
  const was = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = was; }, 1200);
}

// Puts an earlier spin back on the reels without spinning, so it can be held
// and re-rolled around.
function loadReels(h) {
  if (state.spinning) return;
  state.current = { genre: h.genre, character: h.character, style: h.style };
  for (const reel of M.REELS) {
    const t = state.current[reel.key];
    renderStrip(reel.key, [M.pickOne(reel.items, Math.random, t), t, M.pickOne(reel.items, Math.random, t)], 1);
    reelEls[reel.key].strip.classList.remove('moving');
    reelEls[reel.key].strip.style.transform = 'translate3d(0,0,0)';
    reelEls[reel.key].root.classList.add('landed');
  }
  showIdea({ title: h.title, logline: h.logline, source: h.source });
  scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}

// ---------- settings ----------

function getKey() {
  try { return (localStorage.getItem(KEYS.key) || '').trim(); } catch { return ''; }
}

function toggleSettings(force) {
  const open = force ?? el.settings.hidden;
  el.settings.hidden = !open;
  el.settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) { el.apiKey.value = getKey(); el.apiKey.focus(); }
}

function saveKey() {
  const v = el.apiKey.value.trim();
  try { if (v) localStorage.setItem(KEYS.key, v); else localStorage.removeItem(KEYS.key); } catch {}
  el.settingsBtn.textContent = v ? 'Key ✓' : 'Key';
  toggleSettings(false);
}

// ---------- util ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- wire up ----------

buildReels();
fillIdle();
for (const reel of M.REELS) setHeld(reel.key, state.held[reel.key]);
renderHistory();
el.settingsBtn.textContent = getKey() ? 'Key ✓' : 'Key';

el.spin.addEventListener('click', doSpin);
el.reroll.addEventListener('click', () => { if (!state.spinning) { state.seq++; el.actions.hidden = true; generate(state.seq); } });
el.copy.addEventListener('click', () => copyText(ideaText({ ...state.current, title: el.title.textContent, logline: el.line.textContent }), el.copy));
el.clearHistory.addEventListener('click', () => { state.history = state.history.slice(0, 1); save(KEYS.history, state.history); renderHistory(); });
el.history.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) copyText(ideaText(state.history[+b.dataset.copy]), b);
  if (b.dataset.reload) loadReels(state.history[+b.dataset.reload]);
});
el.settingsBtn.addEventListener('click', () => toggleSettings());
el.saveKey.addEventListener('click', saveKey);
el.apiKey.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  doSpin();
});
