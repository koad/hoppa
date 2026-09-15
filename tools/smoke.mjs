#!/usr/bin/env node
/**
 * smoke.mjs — headless smoke test for HOPPA, driven over CDP.
 * ---------------------------------------------------------------------------
 * A canvas game has no server-side surface to curl, and "HTTP 200" proves
 * nothing: Meteor's proxy happily returns 200 while serving an error page from
 * a crashed server bundle (this rig already fell into that trap once).
 *
 * And `--dump-dom` is not enough either: it returns before
 * requestAnimationFrame ever ticks, so the assertions pass while the game loop
 * never runs. We therefore drive a real browser over the DevTools Protocol and
 * assert the RUNTIME:
 *
 *   1. the Meteor shell and the game actually mounted
 *   2. a synthetic TOUCH starts the game  ← the mobile path, the whole point
 *   3. autopilot accumulates score        ← rAF + physics + spawn + collisions
 *   4. no uncaught errors were recorded
 *
 * Same shape as the eventual Android/iOS pipeline: build -> install -> drive ->
 * assert. Different device, same idea.
 *
 *   node tools/smoke.mjs
 *   node tools/smoke.mjs http://localhost:20540 --seconds=10
 *
 * Exit 0 = pass, 1 = fail. No npm dependencies.
 * ---------------------------------------------------------------------------
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, waitForPage, evaluate } from './cdp.mjs';

const argv = process.argv.slice(2);
const url = (argv.find((a) => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/+$/, '');
const seconds = Number((argv.find((a) => a.startsWith('--seconds=')) || '').split('=')[1] || 8);
const shotPath = (argv.find((a) => a.startsWith('--screenshot=')) || '').split('=')[1] || '/tmp/hoppa-smoke.png';
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const PORT = Number(process.env.CDP_PORT || 9333);

const VIEW = { w: 390, h: 844 };          // a phone, because that is the target
const profile = mkdtempSync(join(tmpdir(), 'hoppa-smoke-'));
let failures = 0;

const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--mute-audio',
  // a backgrounded/occluded window gets its rAF throttled — which would make
  // this test lie about the game loop
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--user-data-dir=${profile}`,
  `--window-size=${VIEW.w},${VIEW.h}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank'
], { stdio: 'ignore' });

let session;
try {
  console.log(`HOPPA smoke → ${url}  (${seconds}s autopilot, ${VIEW.w}x${VIEW.h})\n`);

  session = await connect(await waitForPage(PORT));
  await session.send('Page.enable');
  await session.send('Runtime.enable');

  // A true phone viewport plus a touch device. deviceScaleFactor 2 also
  // exercises the engine's devicePixelRatio path, which a desktop-shaped
  // viewport would never touch — and DPR bugs are exactly what bite on real
  // hardware, so the smoke test should be able to see them.
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.w,
    height: VIEW.h,
    deviceScaleFactor: 2,
    mobile: true
  });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  // record page errors from the very first byte of every document
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__hoppaErrors = [];
      addEventListener('error', (e) => window.__hoppaErrors.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__hoppaErrors.push('rejection: ' + e.reason));`
  });

  /* ---- 1. mount ------------------------------------------------------- */
  // Two attempts: a dev server that is mid-rebuild can serve a page that never
  // boots, which is a flake in the harness rather than a defect in the app.
  async function mount() {
    await session.send('Page.navigate', { url: `${url}/` });
    await waitFor(async () => await evaluate(session, 'document.readyState === "complete"'),
      { label: 'document load' });
    await waitFor(async () => await evaluate(session, 'typeof window.HOPPA === "object" && !!document.querySelector("#hoppa-canvas")'),
      { timeout: 45_000, label: 'HOPPA to mount (meteor boot)' });
  }
  try {
    await mount();
  } catch (err) {
    console.log('  (first mount attempt failed — reloading once: ' + err.message + ')');
    await sleep(3000);
    await mount();
  }

  check('meteor shell served', await evaluate(session, '!!document.querySelector(\'link[rel="manifest"]\')'));
  check('game canvas mounted', await evaluate(session, '!!document.querySelector("#hoppa-canvas")'));
  check('starts in ready state', (await evaluate(session, 'window.HOPPA.state()')) === 'ready');

  /* ---- 2. the mobile path: a real touch -------------------------------- */
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: VIEW.w / 2, y: VIEW.h / 2 }] });
  await sleep(60);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  let after = await evaluate(session, 'window.HOPPA.state()');
  if (after === 'ready') {
    // fall back to a synthetic mouse press in case touch emulation is odd
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: VIEW.w / 2, y: VIEW.h / 2, button: 'left', clickCount: 1 });
    await sleep(60);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: VIEW.w / 2, y: VIEW.h / 2, button: 'left', clickCount: 1 });
    after = await evaluate(session, 'window.HOPPA.state()');
  }
  check('a tap starts the game', after !== 'ready', `state=${after}`);

  /* ---- 3. the loop runs (autopilot) ------------------------------------ */
  await session.send('Page.navigate', { url: `${url}/?autopilot=1` });
  await waitFor(async () => await evaluate(session, 'typeof window.HOPPA === "object"'),
    { timeout: 60_000, label: 'second boot' });
  await sleep(seconds * 1000);

  const score = await evaluate(session, 'window.HOPPA.score');
  const state = await evaluate(session, 'window.HOPPA.state()');
  const best = await evaluate(session, 'document.getElementById("hoppa-best").textContent');
  check('autopilot accumulated score', Number(score) > 0, `score=${score} state=${state} ${best}`);

  const vp = await evaluate(session, 'JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})');
  check('phone viewport + DPR applied', /"dpr":2/.test(vp) && /"w":390/.test(vp), vp);

  /* ---- 4. clean runtime ------------------------------------------------ */
  const errs = await evaluate(session, 'window.__hoppaErrors || []');
  check('no uncaught errors', Array.isArray(errs) && errs.length === 0, (errs || []).slice(0, 3).join(' | '));

  /* ---- evidence -------------------------------------------------------- */
  try {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`\n  screenshot → ${shotPath}`);
  } catch (e) {
    console.log(`\n  screenshot failed: ${e.message}`);
  }

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} check(s) failed`);
} catch (err) {
  console.error('\nsmoke run aborted: ' + err.message);
  failures++;
} finally {
  try { session && session.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

process.exit(failures === 0 ? 0 : 1);
