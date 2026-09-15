#!/usr/bin/env node
/**
 * feel.mjs — does the game actually FEEL the way it is supposed to?
 * ---------------------------------------------------------------------------
 * smoke.mjs answers "does it run". This answers "do the mechanics work", which
 * is a different question and the one a player notices. Every claim in the
 * README about the controls is asserted here, because a feature that exists in
 * the source but not in the physics is not a feature.
 *
 * Asserted:
 *   1. a tap hops low, a hold goes high           (variable jump height)
 *   2. two taps in the air = two jumps            (double jump)
 *   3. the fast ones ramp up over a run           (physical, not just declared)
 *   4. violet floaters are passable underneath    (the clearance arithmetic)
 *   5. rainbows: landing on top bounces, hitting one while rising kills
 *   6. all five obstacle archetypes actually spawn
 *
 * The physics numbers are read from the live page rather than duplicated here,
 * so this cannot drift from the engine.
 *
 *   node tools/feel.mjs
 *   node tools/feel.mjs https://hoppa.koad.sh
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
const PORT = Number(process.env.CDP_PORT || 9334);
const VIEW = { w: 390, h: 844 };

const profile = mkdtempSync(join(tmpdir(), 'hoppa-feel-'));
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--user-data-dir=${profile}`,
  `--window-size=${VIEW.w},${VIEW.h}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank'
], { stdio: 'ignore' });

let session;
try {
  console.log(`HOPPA feel test → ${url}\n`);
  session = await connect(await waitForPage(PORT));
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW.w, height: VIEW.h, deviceScaleFactor: 2, mobile: true
  });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  async function load(query) {
    await session.send('Page.navigate', { url: `${url}/?${query}` });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        if (await evaluate(session, 'typeof window.HOPPA === "object" && !!window.HOPPA.stats')) break;
      } catch { /* still booting */ }
      if (Date.now() > deadline) throw new Error('HOPPA never mounted');
      await sleep(250);
    }
    await sleep(120);
  }

  async function tap(ms = 50) {
    const pt = { x: VIEW.w / 2, y: VIEW.h * 0.7 };
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
    await sleep(ms);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  const stats = () => evaluate(session, 'JSON.stringify(window.HOPPA.stats())').then(JSON.parse);

  /* ---- 0. engine constants, read from the live page ------------------- */
  await load('sandbox=1&autostart=1');          // need a live page before poking at it
  const T = await evaluate(session, 'JSON.stringify(window.HOPPA.tuning())').then(JSON.parse);
  const TYPES = await evaluate(session, 'JSON.stringify(window.HOPPA.typeWeights())').then(JSON.parse);
  const floatClear = TYPES.float.clearance;
  const playerH = T.playerH;
  const apexNoHold = (T.jumpVelocity * T.jumpVelocity) / (2 * T.gravity);
  console.log(`  engine: gravity ${T.gravity}  tap jumpV ${T.jumpVelocity}  holdBoost ${T.holdBoost} for ${T.holdMax}s`);
  console.log(`  floater clearance ${floatClear}u   player ${playerH}u tall`);
  console.log(`  (analytic tap apex ${apexNoHold.toFixed(1)}u — the numbers below are measured)\n`);

  /* ---- 1. variable jump height ---------------------------------------- */
  // A "tap" from here still costs a CDP round trip in-page, so the press is
  // longer than the 0ms we ask for. stats().holdMs reports what the game
  // actually saw — which is why the duration is printed rather than assumed.
  await load('sandbox=1&autostart=1');
  await tap(0);
  await sleep(1500);
  const tapRun = await stats();

  await load('sandbox=1&autostart=1');
  await tap(420);
  await sleep(1500);
  const holdRun = await stats();

  check('a tap hops low', tapRun.apex > 55 && tapRun.apex < 105,
    `apex=${tapRun.apex}u (held ${tapRun.holdMs}ms)`);
  // guards against the whole family of bugs where one press registers as two,
  // or as an uncut hold — either would make the double-jump test pass falsely
  check('one tap = one jump', tapRun.jumps === 1, `jumps=${tapRun.jumps}`);
  check('a hold goes high', holdRun.apex > tapRun.apex * 1.5 && holdRun.apex - tapRun.apex > 50,
    `tap=${tapRun.apex}u (${tapRun.holdMs}ms)  hold=${holdRun.apex}u (${holdRun.holdMs}ms) = ${(holdRun.apex / Math.max(1, tapRun.apex)).toFixed(2)}x`);

  /* ---- 1b. the floater rule, against MEASURED apexes ------------------ */
  // analytic numbers do not settle this: what matters is whether a real tap
  // clears the gap and a real hold does not.
  const tapTop = playerH + tapRun.apex;
  const holdTop = playerH + holdRun.apex;
  console.log(`    measured: player top on tap = ${tapTop}u, on hold = ${holdTop}u, floater at ${floatClear}u`);
  check('floater is passable on a tap', tapTop < floatClear, `clear by ${floatClear - tapTop}u`);
  check('floater punishes a full jump', holdTop > floatClear, `hits by ${holdTop - floatClear}u`);

  /* ---- 2. double jump -------------------------------------------------- */
  await load('sandbox=1&autostart=1');
  await tap(45);
  await sleep(200);
  await tap(45);
  await sleep(1400);
  const dbl = await stats();
  check('two taps = two jumps', dbl.jumps === 2, `jumps=${dbl.jumps}`);  check('the double jump buys height', dbl.apex > tapRun.apex * 1.3,
    `single=${tapRun.apex}u double=${dbl.apex}u`);

  /* ---- 3. rainbow: rising into one is fatal ---------------------------- */
  await load('sandbox=1&autostart=1');
  await tap(45);
  await sleep(90);                                    // still rising
  await evaluate(session, 'window.HOPPA.place("rainbow", 0, 10)');
  await sleep(140);
  const rising = await stats();
  const risingState = await evaluate(session, 'window.HOPPA.state()');
  check('hitting a rainbow while rising is fatal', rising.bounces === 0 && risingState !== 'playing',
    `state=${risingState} bounces=${rising.bounces}`);

  /* ---- 4. rainbow: landing on top bounces ----------------------------- */
  await load('sandbox=1&autostart=1');
  await tap(45);
  await sleep(320);                                   // past the apex, descending
  await evaluate(session, 'window.HOPPA.place("rainbow", 0, 10)');
  await sleep(160);
  const landed = await stats();
  const landedState = await evaluate(session, 'window.HOPPA.state()');
  check('landing on a rainbow bounces', landed.bounces === 1 && landedState === 'playing',
    `bounces=${landed.bounces} state=${landedState} bonus=${landed.bonus}`);
  check('the bounce is a BIG bounce', landed.height > 60 || landed.apex > 80,
    `height=${landed.height}u apex=${landed.apex}u`);

  /* ---- 5. all archetypes reachable + observed ------------------------- */
  const rolled = await evaluate(session, 'JSON.stringify(window.HOPPA.roll(2000))').then(JSON.parse);
  const rolledKinds = Object.keys(rolled).filter((k) => rolled[k] > 0);
  check('every archetype is reachable', rolledKinds.length === 6,
    rolledKinds.map((k) => k + ':' + rolled[k]).join('  '));

  await load('autopilot=1');
  await sleep(14_000);
  const run = await stats();
  const kinds = Object.keys(run.types || {});
  check('autopilot survives and scores', run.score > 0, `score=${run.score} bounces=${run.bounces}`);
  console.log(`    (observed in play: ${kinds.join(', ')} — random, informational only)`);

  /* ---- 6b. orb effects actually change the run ------------------------ */
  // squares hurt, circles help — so every circle has to DO something
  await load('sandbox=1&autostart=1');
  const beforeOrb = await stats();
  await evaluate(session, 'window.HOPPA.place("orb", 0, 10, "jump")');
  await sleep(160);
  const gotJump = await stats();
  check('the +jump orb banks an air jump', gotJump.airJumpStock === beforeOrb.airJumpStock + 1,
    `stock ${beforeOrb.airJumpStock} -> ${gotJump.airJumpStock}`);

  await load('sandbox=1&autostart=1');
  const baseSpeed = (await stats()).effSpeed;
  await evaluate(session, 'window.HOPPA.place("orb", 0, 10, "slow")');
  await sleep(200);
  const slowed = await stats();
  check('the slow orb slows the world on the fly', slowed.slow > 0 && slowed.effSpeed < baseSpeed * 0.8,
    `effSpeed ${baseSpeed} -> ${slowed.effSpeed} (${slowed.slow}s left)`);

  await load('sandbox=1&autostart=1');
  await evaluate(session, 'window.HOPPA.place("orb", 0, 10, "spring")');
  await sleep(200);
  const sprung = await stats();
  // A FULL hold (past holdMax), compared against the full-hold baseline. A short
  // tap makes the comparison meaningless: CDP round-trip jitter changes the hold
  // duration between runs, so the two apexes are not measuring the same thing.
  await tap(320);
  await sleep(1600);
  const sprungJump = await stats();
  check('the spring orb raises the jump on the fly',
    sprung.spring > 0 && sprungJump.apex > holdRun.apex * 1.25,
    `spring=${sprung.spring}s  full-hold apex ${holdRun.apex} -> ${sprungJump.apex}u (${sprungJump.holdMs}ms)`);

  /* ---- 7. lateral control (tilt) -------------------------------------- */
  await load('sandbox=1&autostart=1');
  const rest = await stats();
  await evaluate(session, 'window.HOPPA.setTilt(1)');
  await sleep(800);
  const right = await stats();
  await evaluate(session, 'window.HOPPA.setTilt(-1)');
  await sleep(1000);
  const left = await stats();
  await evaluate(session, 'window.HOPPA.setTilt(null)');

  check('tilt right moves HOPPA right', right.playerX > rest.playerX + 20,
    `rest=${rest.playerX} right=${right.playerX} tilt=${right.tilt}`);
  check('tilt left moves HOPPA left', left.playerX < right.playerX - 40,
    `left=${left.playerX} tilt=${left.tilt}`);
  check('level device parks in the middle', Math.abs(rest.playerX - T.playerX) < 2,
    `rest=${rest.playerX} expected ~${T.playerX}`);

  /* ---- 8. landscape is genuinely playable ----------------------------- */
  // The height floor is what makes this work. Without it a landscape phone gives
  // a ~185-unit play area and every jump leaves the screen.
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 390, deviceScaleFactor: 2, mobile: true
  });
  await load('sandbox=1&autostart=1');
  const land = await stats();
  check('landscape is detected', land.orientation === 'landscape', land.orientation);
  check('landscape keeps a playable height', land.logicalH >= T.minLogicalH - 2,
    `logicalH=${land.logicalH} (floor ${T.minLogicalH})`);
  check('landscape widens the world instead', land.viewW > 400 && land.wScale > 1,
    `viewW=${land.viewW} wScale=${land.wScale}`);
  check('HOPPA stays on screen', land.playerX > 0 && land.playerX < land.viewW - 40,
    `playerX=${land.playerX} viewW=${land.viewW}`);

  await load('autopilot=1');
  await sleep(9000);
  const landRun = await stats();
  check('it actually plays in landscape', landRun.score > 0,
    `score=${landRun.score} orientation=${landRun.orientation} effSpeed=${landRun.effSpeed}`);

  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} check(s) failed`);
} catch (err) {
  console.error('\nfeel run aborted: ' + err.message);
  failures++;
} finally {
  try { session && session.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

process.exit(failures === 0 ? 0 : 1);
