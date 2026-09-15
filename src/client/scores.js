/**
 * HOPPA scores — client: the arcade initials entry and the leaderboard.
 *
 * The game engine owns the canvas and calls into here at two moments:
 *   HoppaScoreUI.gameStarted()        — hide any stale entry UI
 *   HoppaScoreUI.gameOver(score, n)   — open the entry if the run qualifies
 * and it asks HoppaScoreUI.isEntryOpen() before letting a tap restart the run,
 * otherwise tapping a letter would start a new game underneath the entry.
 *
 * NOTE: the bridge is HoppaScoreUI, not HoppaScores — that name belongs to the
 * collection declared in both/scores.js.
 */

const CFG = globalThis.HoppaScoreConfig;
const LETTERS = CFG.LETTERS;
const SLOTS = CFG.INITIALS;
const STORAGE_INITIALS = 'hoppa.initials';

/* Character checks rather than regex literals: building '^[A-Z]{3}$' by string
 * concatenation is how the previous version of this file got mangled. */
function isInitials(s) {
  if (typeof s !== 'string' || s.length !== SLOTS) return false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] < 'A' || s[i] > 'Z') return false;
  }
  return true;
}

/** Remember the player's letters: an arcade regular should not have to re-tap
 *  three letters every single run. Falls back to AAA on anything unusable. */
function loadInitials() {
  let raw = '';
  try { raw = String(localStorage.getItem(STORAGE_INITIALS) || '').toUpperCase(); } catch (err) { raw = ''; }
  if (isInitials(raw)) return raw.split('').map((ch) => LETTERS.indexOf(ch));
  return new Array(SLOTS).fill(0);
}

function saveInitials() {
  try { localStorage.setItem(STORAGE_INITIALS, initials()); } catch (err) { /* private mode */ }
}

let board = { allTime: [], recent: [], windowHours: CFG.WINDOW_HOURS };
// `board` starts as a valid-looking empty object, so anything that waits on a
// field of it passes vacuously before the server has answered. This says whether
// a real response has landed.
let boardLoaded = false;
let entryOpen = false;
let entryScore = 0;
let pendingBounces = 0;
let busy = false;
let slots = loadInitials();
let focus = 0;

const $id = (id) => document.getElementById(id);
const initials = () => slots.map((i) => LETTERS[i]).join('');

/** Arcade rule: you only get to write your name if you made the board. */
function qualifies(score) {
  if (!(score > 0)) return false;
  const enters = (list) => !list.length || list.length < CFG.BOARD || score > list[list.length - 1].score;
  return enters(board.recent) || enters(board.allTime);
}

function renderSlots() {
  for (let i = 0; i < SLOTS; i++) {
    const span = document.querySelector('[data-letter="' + i + '"]');
    if (!span) continue;
    span.textContent = LETTERS[slots[i]];
    if (span.parentElement) {
      span.parentElement.classList.toggle('is-focused', entryOpen && i === focus);
    }
  }
}

function renderBoard() {
  const fill = (elId, rows) => {
    const el = $id(elId);
    if (!el) return;
    el.innerHTML = '';
    if (!rows || !rows.length) {
      const li = document.createElement('li');
      li.className = 'hoppa__empty';
      li.textContent = 'no scores yet';
      el.appendChild(li);
      return;
    }
    rows.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'hoppa__row' + (i === 0 ? ' is-top' : '');
      const rank = document.createElement('span');
      rank.className = 'hoppa__rank';
      rank.textContent = String(i + 1) + '.';
      const who = document.createElement('span');
      who.className = 'hoppa__who';
      who.textContent = r.initials || '???';
      const pts = document.createElement('span');
      pts.className = 'hoppa__pts';
      pts.textContent = String(r.score);
      li.appendChild(rank);
      li.appendChild(who);
      li.appendChild(pts);
      el.appendChild(li);
    });
  };
  fill('hoppa-alltime', board.allTime);
  fill('hoppa-recent', board.recent);
  const box = $id('hoppa-board');
  if (box) box.hidden = !((board.allTime && board.allTime.length) || (board.recent && board.recent.length));
}

async function refreshBoard() {
  try {
    board = await Meteor.callAsync('hoppa.leaderboard');
    boardLoaded = true;
    renderBoard();
  } catch (err) {
    // a dead server must never break the game
  }
}

function openEntry(score, bounces) {
  entryOpen = true;
  entryScore = score;
  pendingBounces = bounces || 0;
  slots = loadInitials();     // prefill last time's letters
  focus = 0;
  const box = $id('hoppa-entry');
  if (box) box.hidden = false;
  const cta = $id('hoppa-cta');
  if (cta) cta.textContent = 'enter your initials';
  renderSlots();
}

function closeEntry() {
  entryOpen = false;
  const box = $id('hoppa-entry');
  if (box) box.hidden = true;
  renderSlots();
}

async function submit() {
  if (busy || !entryOpen) return;
  busy = true;
  const enter = $id('hoppa-enter');
  if (enter) enter.disabled = true;
  const who = initials();
  try {
    const res = await Meteor.callAsync('hoppa.submitScore', {
      initials: who, score: entryScore, bounces: pendingBounces
    });
    if (res && res.board) { board = res.board; boardLoaded = true; renderBoard(); }
    else await refreshBoard();
    saveInitials();
    closeEntry();
    const cta = $id('hoppa-cta');
    if (cta) cta.textContent = who + ' ' + entryScore + ' saved — tap to retry';
  } catch (err) {
    closeEntry();
    const cta = $id('hoppa-cta');
    if (cta) cta.textContent = ((err && err.reason) || 'could not save') + ' — tap to retry';
  } finally {
    busy = false;
    if (enter) enter.disabled = false;
  }
}

function bump(slot, dir) {
  if (!entryOpen || slot < 0 || slot >= SLOTS) return;
  slots[slot] = (slots[slot] + dir + LETTERS.length) % LETTERS.length;
  focus = slot;
  renderSlots();
}

function wire() {
  // These must not fall through to the canvas: a tap on a letter would
  // otherwise restart the run underneath the entry UI.
  document.querySelectorAll('.hoppa__arrow').forEach((btn) => {
    const halt = (e) => { e.preventDefault(); e.stopPropagation(); };
    btn.addEventListener('pointerdown', halt);
    btn.addEventListener('click', (e) => {
      halt(e);
      bump(Number(btn.dataset.slot), Number(btn.dataset.dir));
    });
  });

  const enter = $id('hoppa-enter');
  if (enter) {
    enter.addEventListener('pointerdown', (e) => e.stopPropagation());
    enter.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); submit(); });
  }

  // keyboard: typed letters, arrows, enter. Capture phase so the game's own key
  // handling never races it (the engine also guards on isEntryOpen).
  window.addEventListener('keydown', (e) => {
    if (!entryOpen) return;
    const k = e.key;
    if (k === 'Enter') { e.preventDefault(); submit(); return; }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault(); bump(focus, k === 'ArrowUp' ? 1 : -1); return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      focus = (focus + (k === 'ArrowRight' ? 1 : SLOTS - 1)) % SLOTS;
      renderSlots();
      return;
    }
    if (k.length === 1 && isInitials(k.toUpperCase() + 'AA')) {
      e.preventDefault();
      slots[focus] = LETTERS.indexOf(k.toUpperCase());
      focus = (focus + 1) % SLOTS;
      renderSlots();
    }
  }, true);
}

if (typeof Template !== 'undefined') {
  Template.ApplicationHome.onRendered(function () {
    wire();
    renderSlots();
    refreshBoard();
  });
}

globalThis.HoppaScoreUI = {
  gameStarted() { closeEntry(); },
  gameOver(score, bounces) {
    if (qualifies(score)) openEntry(score, bounces);
    else closeEntry();
  },
  isEntryOpen() { return entryOpen; },
  refresh: refreshBoard,
  // test affordances for tools/scores.mjs
  _board: () => board,
  _loaded: () => boardLoaded,
  _initials: initials,
  _remembered: () => loadInitials().map((i) => LETTERS[i]).join(''),
  _bump: bump,
  _submit: submit,
  // the arcade gate is a RULE, so it is testable without writing a fake #1 to
  // the real board — which a fixed test score eventually had to do
  _qualifies: qualifies,
  _openEntry: openEntry
};
