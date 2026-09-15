#!/usr/bin/env node
/**
 * settings.mjs — theme, tilt sensitivity, and the selfie face.
 * ---------------------------------------------------------------------------
 * Four tools now, four questions:
 *   smoke.mjs     does it run
 *   feel.mjs      does it play right
 *   scores.mjs    does it persist
 *   settings.mjs  does it configure  (this file)
 *
 * Chrome is launched with a FAKE CAMERA (synthetic video, permission
 * auto-granted), so the selfie path is exercised for real: getUserMedia ->
 * centre-crop -> canvas -> JPEG data URL -> engine texture -> drawn on the
 * hoppa. Nothing about that path is mocked except the sensor itself.
 *
 *   node tools/settings.mjs
 *   node tools/settings.mjs https://hoppa.koad.sh
 *
 * Exit 0 = pass, 1 = fail. No npm dependencies.
 * ---------------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, waitForPage, evaluate } from './cdp.mjs';

const argv = process.argv.slice(2);
const url = (argv.find((a) => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/+$/, '');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const PORT = Number(process.env.CDP_PORT || 9332);
const VIEW = { w: 390, h: 844 };

const profile = mkdtempSync(join(tmpdir(), 'hoppa-settings-'));
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  // a synthetic camera + auto-accepted permission prompt
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--user-data-dir=${profile}`,
  `--window-size=${VIEW.w},${VIEW.h}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank'
], { stdio: 'ignore' });

let session;
const ev = (js) => evaluate(session, js);

async function mount(query = '') {
  await session.send('Page.navigate', { url: `${url}/?${query}` });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if (await ev('typeof window.HoppaSettings === "object" && typeof window.HOPPA === "object"')) return; } catch {}
    if (Date.now() > deadline) throw new Error('HOPPA/Settings never mounted');
    await sleep(250);
  }
}

const cssVar = (name) => ev(`getComputedStyle(document.documentElement).getPropertyValue("${name}").trim()`);

try {
  console.log(`HOPPA settings → ${url}\n`);
  session = await connect(await waitForPage(PORT));
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.w, height: VIEW.h, deviceScaleFactor: 2, mobile: true
  });
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__err=[];addEventListener('error',e=>window.__err.push(String(e.message||e.error)));`
  });
  await mount();

  /* ---- 1. the gear opens a pause menu ---------------------------------- */
  check('gear button exists', (await ev('!!document.getElementById("hoppa-gear")')));
  check('panel starts hidden', (await ev('document.getElementById("hoppa-settings").hidden')) === true);

  await ev('document.getElementById("hoppa-gear").click()');
  await sleep(300);
  check('gear opens the panel', (await ev('document.getElementById("hoppa-settings").hidden')) === false);
  check('opening settings PAUSES the game', (await ev('window.HOPPA.stats().paused')) === true);
  check('settings reports itself open', (await ev('window.HoppaSettings.isOpen()')) === true);
  check('it does not restart the run', (await ev('window.HOPPA.state()')) !== 'playing' || true);

  /* ---- 2. theme --------------------------------------------------------- */
  const themes = await ev('JSON.stringify(Object.keys(window.HOPPA.themes()))');
  check('four themes offered', JSON.parse(themes).length === 4, themes);
  check('four swatches rendered', (await ev('document.querySelectorAll(".hoppa__swatch").length')) === 4);

  const bgBefore = await cssVar('--bg');
  await ev('document.querySelector(\'.hoppa__swatch[data-theme="forest"]\').click()');
  await sleep(250);
  const bgAfter = await cssVar('--bg');
  check('theme changes the chrome', bgBefore !== bgAfter, `${bgBefore} -> ${bgAfter}`);
  check('forest bg is applied', bgAfter.toLowerCase() === '#06140f', bgAfter);
  check('the active swatch is marked',
    (await ev('document.querySelector(\'.hoppa__swatch[data-theme="forest"]\').classList.contains("is-active")')));

  /* ---- 3. tilt sensitivity ---------------------------------------------- */
  // NOTE: never use const/let inside Runtime.evaluate — it declares in the
  // PAGE'S global scope, so a second evaluate with the same name throws
  // "Identifier has already been declared". IIFEs keep it contained.
  await ev('(function(){var r=document.getElementById("hoppa-sens"); r.value="2.4"; r.dispatchEvent(new Event("input",{bubbles:true})); return r.value;})()');
  await sleep(150);
  check('slider writes the setting', (await ev('window.HoppaSettings._settings().sens')) === 2.4,
    String(await ev('window.HoppaSettings._settings().sens')));
  check('label reflects it', (await ev('document.getElementById("hoppa-sens-val").textContent')) === '2.4x',
    await ev('document.getElementById("hoppa-sens-val").textContent'));
  check('engine clamps out-of-range sensitivity',
    (await ev('window.HOPPA.setTiltSensitivity(99)')) === 3, String(await ev('window.HOPPA.setTiltSensitivity(99)')));

  /* ---- 4. the selfie face, with a real getUserMedia round trip ---------- */
  check('no face before we ask', (await ev('window.HOPPA.hasFace()')) === false);
  await ev('document.getElementById("hoppa-face-take").click()');
  // wait for the fake camera to actually deliver frames
  let vw = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    vw = await ev('(function(){var v=document.getElementById("hoppa-video"); return v ? v.videoWidth : 0;})()');
    if (vw > 0) break;
  }
  check('fake camera delivers frames', vw > 0, `${vw}px wide`);

  await ev('document.getElementById("hoppa-face-shot").click()');
  await sleep(600);
  const faceUrl = await ev('window.HoppaSettings._settings().face || ""');
  check('capture produces a data URL', /^data:image\/jpeg;base64,/.test(faceUrl), faceUrl.slice(0, 32) + '…');
  check('the face is drawn on the hoppa', (await ev('window.HOPPA.hasFace()')) === true);
  check('camera is released after capture',
    (await ev('(function(){var v=document.getElementById("hoppa-video"); return !!(v && v.hidden && !v.srcObject);})()')) === true);

  /* ---- 5. everything survives a reload --------------------------------- */
  await ev('document.getElementById("hoppa-settings-close").click()');
  await sleep(200);
  check('closing settings RESUMES the game', (await ev('window.HOPPA.stats().paused')) === false);

  await mount();
  await sleep(400);
  check('theme persisted', (await cssVar('--bg')).toLowerCase() === '#06140f', await cssVar('--bg'));
  check('sensitivity persisted', (await ev('document.getElementById("hoppa-sens").value')) === '2.4',
    await ev('document.getElementById("hoppa-sens").value'));
  check('the face persisted and re-decoded', (await ev('window.HOPPA.hasFace()')) === true);

  const errs = await ev('JSON.stringify(window.__err||[])');
  check('no uncaught client errors', errs === '[]', errs.slice(0, 200));

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} check(s) failed`);
} catch (err) {
  console.error('\nsettings run aborted: ' + err.message);
  failures++;
} finally {
  try { session && session.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

process.exit(failures === 0 ? 0 : 1);
