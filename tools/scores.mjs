#!/usr/bin/env node
/**
 * scores.mjs — does the server side of the leaderboard actually work?
 * ---------------------------------------------------------------------------
 * Three tools now, three questions:
 *   smoke.mjs   does it run
 *   feel.mjs    does it play right
 *   scores.mjs  does it persist  (this file)
 *
 * A leaderboard is the one part of a client-side game that can silently be a
 * lie: the UI renders, the button feels responsive, and nothing was ever saved.
 * So this drives the real initials entry through the real DOM, submits over the
 * real DDP connection, and then re-reads the board from the server to confirm
 * the row came back.
 *
 *   node tools/scores.mjs
 *   node tools/scores.mjs https://hoppa.koad.sh
 *
 * NOTE: it writes one real row to the board, with initials TST, so the test is
 * visible in the app afterwards. That is deliberate — a leaderboard nobody can
 * see working is not evidence.
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
const PORT = Number(process.env.CDP_PORT || 9335);
const VIEW = { w: 390, h: 844 };
const TEST_SCORE = 7;                 // low, so it sits at the bottom of the board
const TEST_INITIALS = 'TST';

const profile = mkdtempSync(join(tmpdir(), 'hoppa-scores-'));
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  `--user-data-dir=${profile}`, `--window-size=${VIEW.w},${VIEW.h}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: 'ignore' });

let session;
const ev = (js) => evaluate(session, js);

try {
  console.log(`HOPPA scores → ${url}\n`);
  session = await connect(await waitForPage(PORT));
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.w, height: VIEW.h, deviceScaleFactor: 2, mobile: true
  });
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__err=[];addEventListener('error',e=>window.__err.push(String(e.message||e.error)));`
  });
  await session.send('Page.navigate', { url: `${url}/` });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try { if (await ev('typeof window.HoppaScoreUI === "object" && typeof window.HOPPA === "object"')) break; } catch {}
    if (Date.now() > deadline) throw new Error('HOPPA never mounted');
    await sleep(250);
  }

  /* ---- 1. the board loads from the server ------------------------------ */
  const loaded = await (async () => {
    for (let i = 0; i < 60; i++) {
      const ok = await ev('!!(window.HoppaScoreUI._board() && window.HoppaScoreUI._board().windowHours)');
      if (ok) return true;
      await sleep(250);
    }
    return false;
  })();
  check('leaderboard fetched from the server', loaded,
    await ev('JSON.stringify(window.HoppaScoreUI._board().windowHours)'));

  const cols = await ev('JSON.stringify({all: !!document.getElementById("hoppa-alltime"), recent: !!document.getElementById("hoppa-recent")})');
  check('board columns rendered', /"all":true/.test(cols) && /"recent":true/.test(cols), cols);
  check('72h window is 72h', (await ev('window.HoppaScoreUI._board().windowHours')) === 72);

  /* ---- 2. a qualifying score opens the entry --------------------------- */
  await ev('window.HoppaScoreUI.gameOver(' + TEST_SCORE + ', 0)');
  await sleep(250);
  check('qualifying run opens the initials entry', await ev('window.HoppaScoreUI.isEntryOpen()'));
  check('entry is visible in the DOM', (await ev('document.getElementById("hoppa-entry").hidden')) === false);
  check('three letter slots exist', (await ev('document.querySelectorAll("[data-letter]").length')) === 3,
    await ev('window.HoppaScoreUI._initials()'));

  /* ---- 3. drive the REAL buttons, not the API -------------------------- */
  // Tap counts are computed from the CURRENT value, never assumed: the slots
  // are prefilled with last run's letters, so a fixed number of taps lands on a
  // different letter every time.
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  async function setSlot(i, target) {
    const cur = await ev(`window.HoppaScoreUI._initials()[${i}]`);
    const taps = (LETTERS.indexOf(target) - LETTERS.indexOf(cur) + 26) % 26;
    for (let k = 0; k < taps; k++) {
      await ev(`document.querySelector('[data-slot="${i}"][data-dir="1"]').click()`);
    }
    return taps;
  }
  const tapsUsed = [];
  for (let i = 0; i < TEST_INITIALS.length; i++) tapsUsed.push(await setSlot(i, TEST_INITIALS[i]));
  const typed = await ev('window.HoppaScoreUI._initials()');
  check('letter buttons set the initials', typed === TEST_INITIALS,
    `typed "${typed}" wanted "${TEST_INITIALS}" using ${tapsUsed.join('/')} taps`);

  /* ---- 4. submit, and confirm the SERVER now knows --------------------- */
  // Verified by ROW COUNT, not by hunting for the row in the top-5. Once the
  // board is full a low test score is legitimately not displayed, so grepping
  // the visible board would report a false negative for a working round-trip.
  const rowsBefore = await ev('window.HoppaScoreUI._board().total');
  await ev('document.getElementById("hoppa-enter").click()');
  let rowsAfter = rowsBefore;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    rowsAfter = await ev('window.HoppaScoreUI._board().total');
    if (rowsAfter > rowsBefore) break;
  }
  check('score round-tripped through the server', rowsAfter === rowsBefore + 1,
    `stored rows ${rowsBefore} -> ${rowsAfter}`);
  check('entry closed after submit', (await ev('window.HoppaScoreUI.isEntryOpen()')) === false);

  /* ---- 5. server-side validation actually rejects rubbish -------------- */
  const badInitials = await ev(`Meteor.callAsync('hoppa.submitScore', {initials:'toolong', score:5}).then(()=> 'ACCEPTED').catch(e=> 'REJECTED: '+e.error)`);
  check('server rejects bad initials', /REJECTED/.test(badInitials), badInitials);
  const badScore = await ev(`Meteor.callAsync('hoppa.submitScore', {initials:'ABC', score: 999999999}).then(()=> 'ACCEPTED').catch(e=> 'REJECTED: '+e.error)`);
  check('server rejects an absurd score', /REJECTED/.test(badScore), badScore);

  const errs = await ev('JSON.stringify(window.__err||[])');
  check('no uncaught client errors', errs === '[]', errs.slice(0, 200));

  /* ---- 6. the letters are remembered for next time --------------------- */
  // an arcade regular should not re-tap three letters every run
  await session.send('Page.navigate', { url: `${url}/` });
  const back = Date.now() + 60_000;
  for (;;) {
    try { if (await ev('typeof window.HoppaScoreUI === "object"')) break; } catch {}
    if (Date.now() > back) throw new Error('page did not come back');
    await sleep(250);
  }
  const remembered = await ev('window.HoppaScoreUI._remembered()');
  check('initials default to last time', remembered === TEST_INITIALS,
    `remembered "${remembered}", wanted "${TEST_INITIALS}"`);
  check('slots are prefilled with them', (await ev('window.HoppaScoreUI._initials()')) === TEST_INITIALS, await ev('window.HoppaScoreUI._initials()'));

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} check(s) failed`);
  console.log(`(one row with initials ${TEST_INITIALS} was written — that is the evidence;`);
  console.log(` it may not be visible if the board is already full of better scores)`);
} catch (err) {
  console.error('\nscores run aborted: ' + err.message);
  failures++;
} finally {
  try { session && session.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

process.exit(failures === 0 ? 0 : 1);
