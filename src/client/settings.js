/**
 * HOPPA settings — theme, tilt sensitivity, and your own face on the hoppa.
 *
 * Owns: localStorage persistence, the settings panel DOM, the camera, and
 * pushing values into the engine. The engine stays dumb — it exposes setters
 * (setTheme / setTiltSensitivity / setFace / setPaused) and this file is the
 * only thing that decides what they should be.
 *
 * The panel is a PAUSE MENU: it stops the simulation while open, and no input
 * is allowed to reach the game (the engine checks HoppaSettings.isOpen()).
 */

const SETTINGS_KEY = 'hoppa.settings';
const FACE_SIZE = 160;                 // enough for a 30-unit hoppa at 3x DPR

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (err) { return {}; }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (err) { /* private mode */ }
}

const settings = Object.assign({ theme: 'midnight', sens: 1, face: null }, loadSettings());

let stream = null;
let panelOpen = false;

const el = (id) => document.getElementById(id);
const engine = () => globalThis.HOPPA;

function labelFor(name) {
  const T = (engine() && engine().themes ? engine().themes() : {})[name];
  if (!T) return 'linear-gradient(160deg, #0b1020, #141d38)';
  return 'linear-gradient(160deg, ' + T.sky0 + ' 0%, ' + T.sky1 + ' 55%, ' + T.player + ' 100%)';
}

/** Push every setting into the engine, and paint the controls from it. Safe to
 *  call before the engine exists (it just renders). */
function applyAll() {
  const H = engine();
  if (H) {
    if (H.setTheme) H.setTheme(settings.theme);
    if (H.setTiltSensitivity) H.setTiltSensitivity(settings.sens);
    if (H.setFace) H.setFace(settings.face || null);
  }
  // Render on load too, not only when the panel opens: otherwise the slider sits
  // at its HTML default until the first open and lies about the stored value.
  renderSwatches();
  renderSens();
  renderFace();
}

function renderSwatches() {
  const box = el('hoppa-themes');
  if (!box) return;
  const H = engine();
  const names = Object.keys(H && H.themes ? H.themes() : { midnight: 1 });
  box.innerHTML = '';
  names.forEach((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hoppa__swatch' + (name === settings.theme ? ' is-active' : '');
    b.dataset.theme = name;
    b.setAttribute('aria-label', name);
    b.style.background = labelFor(name);
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settings.theme = name;
      saveSettings();
      if (engine() && engine().setTheme) engine().setTheme(name);
      renderSwatches();
    });
    box.appendChild(b);
  });
}

function renderSens() {
  const range = el('hoppa-sens');
  const out = el('hoppa-sens-val');
  if (range) range.value = String(settings.sens);
  if (out) out.textContent = Number(settings.sens).toFixed(1) + 'x';
}

function renderFace() {
  const prev = el('hoppa-face-preview');
  const clear = el('hoppa-face-clear');
  const note = el('hoppa-face-note');
  if (prev) prev.style.backgroundImage = settings.face ? 'url(' + settings.face + ')' : '';
  if (prev) prev.style.color = settings.face ? 'transparent' : '';
  if (clear) clear.hidden = !settings.face;
  if (note && !stream) note.textContent = settings.face ? 'your face is on the hoppa' : '';
}

/* --- camera ------------------------------------------------------------- */

async function startCamera() {
  const video = el('hoppa-video');
  const note = el('hoppa-face-note');
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (note) note.textContent = 'no camera API in this browser';
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } },
      audio: false
    });
    if (video) {
      video.srcObject = stream;
      video.hidden = false;
      await video.play().catch(() => {});
    }
    if (el('hoppa-face-shot')) el('hoppa-face-shot').hidden = false;
    if (note) note.textContent = 'frame your face, then capture';
    return true;
  } catch (err) {
    if (note) note.textContent = 'camera unavailable: ' + ((err && err.name) || 'error');
    stream = null;
    return false;
  }
}

function stopCamera() {
  const video = el('hoppa-video');
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (video) { video.srcObject = null; video.hidden = true; }
  if (el('hoppa-face-shot')) el('hoppa-face-shot').hidden = true;
}

function captureFace() {
  const video = el('hoppa-video');
  if (!video || !video.videoWidth) return false;
  const size = FACE_SIZE;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  // centre-crop so a wide camera frame still lands square on the hoppa
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.min(vw, vh);
  g.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, size, size);
  let url = null;
  try { url = c.toDataURL('image/jpeg', 0.82); } catch (err) { url = null; }
  if (!url) return false;
  settings.face = url;
  saveSettings();
  if (engine() && engine().setFace) engine().setFace(url);
  stopCamera();
  renderFace();
  return true;
}

function clearFace() {
  settings.face = null;
  saveSettings();
  if (engine() && engine().setFace) engine().setFace(null);
  renderFace();
}

/* --- panel -------------------------------------------------------------- */

function openPanel() {
  panelOpen = true;
  const box = el('hoppa-settings');
  if (box) box.hidden = false;
  if (engine() && engine().setPaused) engine().setPaused(true);
  renderSwatches();
  renderSens();
  renderFace();
}

function closePanel() {
  panelOpen = false;
  const box = el('hoppa-settings');
  if (box) box.hidden = true;
  stopCamera();
  if (engine() && engine().setPaused) engine().setPaused(false);
}

function wire() {
  const gear = el('hoppa-gear');
  if (gear) {
    gear.addEventListener('pointerdown', (e) => e.stopPropagation());
    gear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); });
  }

  const panel = el('hoppa-settings');
  // the panel sits inside the game root, so taps must not reach the canvas
  if (panel) panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  const close = el('hoppa-settings-close');
  if (close) {
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closePanel(); });
  }

  const range = el('hoppa-sens');
  if (range) {
    const onInput = () => {
      settings.sens = Number(range.value) || 1;
      saveSettings();
      if (engine() && engine().setTiltSensitivity) engine().setTiltSensitivity(settings.sens);
      renderSens();
    };
    range.addEventListener('input', onInput);
    range.addEventListener('change', onInput);
  }

  const take = el('hoppa-face-take');
  if (take) take.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startCamera(); });

  const shot = el('hoppa-face-shot');
  if (shot) shot.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); captureFace(); });

  const clear = el('hoppa-face-clear');
  if (clear) clear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clearFace(); });

  // Escape closes, for the keyboard
  window.addEventListener('keydown', (e) => {
    if (panelOpen && e.key === 'Escape') { e.preventDefault(); closePanel(); }
  }, true);
}

if (typeof Template !== 'undefined') {
  Template.ApplicationHome.onRendered(function () {
    wire();
    applyAll();       // must run after the engine's own onRendered has created HOPPA
  });
}

globalThis.HoppaSettings = {
  isOpen: () => panelOpen,
  open: openPanel,
  close: closePanel,
  apply: applyAll,
  // test affordances for tools/settings.mjs
  _settings: () => settings,
  _startCamera: startCamera,
  _capture: captureFace
};
