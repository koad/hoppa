/* HOPPA — game engine (client)
 * ---------------------------------------------------------------------------
 * A one-gesture jumping game. Single file, no deps, no framework coupling:
 * Blaze only mounts it, everything after that is plain canvas + rAF.
 *
 * WORLD MODEL — why the game feels the same on every device:
 *   The logical world is ALWAYS 400 units wide. We scale the canvas so 400
 *   units map to the device width, and the visible height is whatever the
 *   aspect ratio gives us. Jump arcs, obstacle gaps and hitboxes are therefore
 *   identical on a 5" phone and an iPad — a taller screen just shows more sky.
 *   All physics below is in these logical units.
 *
 * INTENT: this is the koad:io Capacitor/PWA learning rig. Keep it readable,
 * keep it dependency-free, and keep the runtime surface small so that the
 * Capacitor layer (and later the native builds) are the interesting part.
 * ---------------------------------------------------------------------------
 */

const Hoppa = (() => {
  'use strict';

  const LOGICAL_W = 400;          // never changes — see world model above
  const STORAGE_BEST = 'hoppa.best';

  const TUNING = {
    gravity: 2300,               // units/s^2
    jumpVelocity: -780,          // units/s at lift-off
    holdBoost: 1500,             // extra upward accel while the jump is held
    holdMax: 0.16,               // seconds the boost may apply
    coyote: 0.09,                // grace after leaving the ground
    buffer: 0.11,                // grace for a tap landing just before touch-down
    speedStart: 250,
    speedMax: 700,
    speedRamp: 8.5,              // units/s gained per second survived
    gapMin: 0.85,
    gapMax: 1.40,                // spawn gaps in seconds-at-current-speed
    groundH: 84,
    playerX: 64,
    playerW: 30,
    playerH: 30,
    hitInsetX: 3,
    hitInsetY: 4,
    deathHold: 0.55              // seconds of death animation before the overlay
  };

  const COLORS = {
    sky0: '#0b1020',
    sky1: '#141d38',
    star: '#8fa6d8',
    hillFar: '#182443',
    hillNear: '#1d2b50',
    ground: '#243357',
    groundLip: '#57e2c8',
    player: '#57e2c8',
    playerInk: '#06202a',
    obstacle: '#ffb454',
    obstacleInk: '#5a3608',
    dust: 'rgba(87,226,200,0.55)'
  };

  /* --- tiny helpers ------------------------------------------------------ */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  function rounded(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /* --- audio: lazily created on first gesture, fails silent -------------- */

  function makeBlipper() {
    let ctx = null;
    const ensure = () => {
      if (ctx) return ctx;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      } catch (e) { ctx = null; }
      return ctx;
    };
    const blip = (freq, dur, type, gain) => {
      const ac = ensure();
      if (!ac) return;
      try {
        if (ac.state === 'suspended') ac.resume();
        const osc = ac.createOscillator();
        const amp = ac.createGain();
        osc.type = type || 'square';
        osc.frequency.setValueAtTime(freq, ac.currentTime);
        amp.gain.setValueAtTime(gain == null ? 0.05 : gain, ac.currentTime);
        amp.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
        osc.connect(amp).connect(ac.destination);
        osc.start();
        osc.stop(ac.currentTime + dur);
      } catch (e) { /* audio is a nicety, never a failure */ }
    };
    return {
      jump: () => blip(520, 0.09, 'square', 0.04),
      land: () => blip(180, 0.05, 'sine', 0.03),
      die:  () => { blip(300, 0.18, 'sawtooth', 0.05); setTimeout(() => blip(150, 0.28, 'sawtooth', 0.05), 90); }
    };
  }

  /* --- the game ---------------------------------------------------------- */

  function create(root) {
    const canvas = root.querySelector('#hoppa-canvas');
    const overlay = root.querySelector('#hoppa-overlay');
    const scoreEl = root.querySelector('#hoppa-score');
    const bestEl = root.querySelector('#hoppa-best');
    const ctaEl = root.querySelector('#hoppa-cta');
    const subEl = root.querySelector('#hoppa-sub');
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    const sfx = makeBlipper();

    // view state
    let scale = 1, dpr = 1, logicalH = 800, groundY = 0;
    let running = false, paused = false, raf = 0, lastT = 0;

    // game state
    let state = 'ready';         // ready | playing | dying | over
    let deadFor = 0;
    let vy = 0, onGround = true, holding = false, boostLeft = 0;
    let coyote = 0, jumpBuffered = 0;
    let speed = TUNING.speedStart, distance = 0, score = 0, scroll = 0;
    let obstacles = [], dust = [], shake = 0;
    let hills = [], stars = [];
    let best = 0;
    try { best = parseInt(localStorage.getItem(STORAGE_BEST) || '0', 10) || 0; } catch (e) { best = 0; }

    const player = { x: TUNING.playerX, y: 0, w: TUNING.playerW, h: TUNING.playerH };

    /* Headless / CI hooks. A game has no server-side surface to curl, which
     * makes it the hardest thing in a stack to smoke-test. These flags make the
     * runtime assertable from a headless browser:
     *
     *   ?autostart=1   skip the ready screen and begin playing
     *   ?autopilot=1   implies autostart, and jumps for itself
     *
     * CI assertion: with ?autopilot=1 the score must be > 0 after a few seconds
     * of virtual time — which proves rAF, physics, obstacle spawning and
     * scoring all ran. See tools/smoke.mjs.
     */
    const params = (() => {
      try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(''); }
    })();
    const truthyFlag = (v) => v != null && ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
    const AUTOPILOT = truthyFlag(params.get('autopilot'));
    const AUTOSTART = AUTOPILOT || truthyFlag(params.get('autostart'));

    /* --- layout ---------------------------------------------------------- */

    function resize() {
      const cssW = root.clientWidth || window.innerWidth;
      const cssH = root.clientHeight || window.innerHeight;
      dpr = clamp(window.devicePixelRatio || 1, 1, 3);
      scale = cssW / LOGICAL_W;

      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      logicalH = cssH / scale;
      groundY = logicalH - TUNING.groundH;

      // draw in logical units; DPR is folded into the transform
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);

      player.y = groundY - player.h;

      // regenerated scenery for the new height
      stars = Array.from({ length: 46 }, () => ({
        x: rand(0, LOGICAL_W), y: rand(0, logicalH * 0.72),
        r: rand(0.5, 1.5), a: rand(0.15, 0.7)
      }));
      hills = [
        { y: groundY, amp: rand(70, 110), step: 190, off: 0, spd: 0.10, col: COLORS.hillFar },
        { y: groundY, amp: rand(46, 70),  step: 150, off: 0, spd: 0.22, col: COLORS.hillNear }
      ];
    }

    /* --- input ----------------------------------------------------------- */

    function press() {
      if (state === 'ready' || state === 'over') { start(); return; }
      if (state !== 'playing') return;
      holding = true;
      jumpBuffered = TUNING.buffer;
      tryJump();
    }

    function release() { holding = false; }

    function tryJump() {
      if (!onGround && coyote <= 0) return;   // buffered by jumpBuffered
      vy = TUNING.jumpVelocity;
      onGround = false;
      coyote = 0;
      jumpBuffered = 0;
      boostLeft = TUNING.holdMax;
      sfx.jump();
      for (let i = 0; i < 6; i++) {
        dust.push({ x: player.x + player.w / 2, y: groundY,
          vx: rand(-40, 10), vy: rand(-70, -15), life: rand(0.25, 0.5), t: 0 });
      }
    }

    /** One jump, timed the way a good player would. Speed-invariant on purpose:
     *  both the trigger gap and the airtime scale with the scroll speed, so the
     *  same threshold works from the first obstacle to the last. */
    function autopilotStep() {
      let next = null;
      for (const o of obstacles) {
        if (o.x + o.w > player.x + player.w && (!next || o.x < next.x)) next = o;
      }
      if (!next) return;
      if (next.x - (player.x + player.w) <= speed * 0.42) tryJump();
    }

    const onPointerDown = (e) => { e.preventDefault(); press(); };
    const onPointerUp = (e) => { e.preventDefault(); release(); };
    const onKeyDown = (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); if (!e.repeat) press(); }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); release(); }
    };

    function bind(flag) {
      const fn = flag ? 'addEventListener' : 'removeEventListener';
      root[fn]('pointerdown', onPointerDown, { passive: false });
      root[fn]('pointerup', onPointerUp, { passive: false });
      root[fn]('pointercancel', onPointerUp, { passive: false });
      window[fn]('keydown', onKeyDown);
      window[fn]('keyup', onKeyUp);
    }

    // pause when the tab/app is backgrounded — rAF stops anyway, this keeps
    // the clock honest so the player doesn't return to a face-full of cactus
    const onVisibility = () => {
      paused = document.hidden;
      if (!paused) { lastT = 0; }
    };

    /* --- lifecycle ------------------------------------------------------- */

    function start() {
      state = 'playing';
      vy = 0; onGround = true; holding = false; boostLeft = 0;
      coyote = 0; jumpBuffered = 0;
      speed = TUNING.speedStart; distance = 0; score = 0;
      obstacles = []; dust = []; shake = 0; deadFor = 0;
      nextGap = 0.9;
      player.y = groundY - player.h;
      scoreEl.textContent = '0';
      overlay.classList.add('is-hidden');
      lastT = 0;
    }

    function die() {
      state = 'dying';
      deadFor = 0;
      shake = 14;
      sfx.die();
      for (let i = 0; i < 22; i++) {
        dust.push({ x: player.x + player.w / 2, y: player.y + player.h / 2,
          vx: rand(-190, 190), vy: rand(-260, 40), life: rand(0.35, 0.8), t: 0 });
      }
    }

    function gameOver() {
      state = 'over';
      if (score > best) {
        best = score;
        try { localStorage.setItem(STORAGE_BEST, String(best)); } catch (e) { /* private mode */ }
      }
      bestEl.textContent = 'best ' + best;
      ctaEl.textContent = 'tap to retry';
      subEl.textContent = 'score ' + score;
      overlay.classList.remove('is-hidden');
    }

    /* --- simulation ------------------------------------------------------ */

    let nextGap = 0.9;

    function spawnObstacle() {
      const tall = Math.random() < 0.55;
      const w = tall ? rand(18, 24) : rand(28, 40);
      const h = tall ? rand(42, 54) : rand(26, 36);
      obstacles.push({ x: LOGICAL_W + 20, w, h, y: groundY - h, seed: Math.random() });
    }

    function update(dt) {
      // scenery always drifts, even in the ready state
      const drift = state === 'playing' ? speed : TUNING.speedStart * 0.45;
      scroll += drift * dt;

      for (const h of hills) h.off += drift * h.spd * dt;

      if (state === 'ready') {
        // idle bob so the character feels alive before the first tap
        idleT += dt;
        player.y = groundY - player.h - Math.sin(idleT * 2.4) * 3;
        decayDust(dt);
        return;
      }

      if (state === 'dying') {
        deadFor += dt;
        shake = Math.max(0, shake - dt * 40);
        player.y = Math.min(groundY - player.h, player.y + 520 * dt);
        decayDust(dt);
        if (deadFor >= TUNING.deathHold) gameOver();
        return;
      }

      if (state === 'over') { shake = Math.max(0, shake - dt * 40); decayDust(dt); return; }

      // --- playing ---
      speed = Math.min(TUNING.speedMax, speed + TUNING.speedRamp * dt);
      distance += speed * dt;
      if (AUTOPILOT) autopilotStep();
      const newScore = Math.floor(distance / 12);
      if (newScore !== score) { score = newScore; scoreEl.textContent = String(score); }

      // vertical motion
      if (jumpBuffered > 0) jumpBuffered -= dt;
      if (coyote > 0) coyote -= dt;

      let g = TUNING.gravity;
      if (holding && boostLeft > 0 && !onGround) {
        g -= TUNING.holdBoost;
        boostLeft -= dt;
      }
      vy += g * dt;
      player.y += vy * dt;

      if (player.y >= groundY - player.h) {
        if (!onGround) {
          sfx.land();
          for (let i = 0; i < 5; i++) {
            dust.push({ x: player.x + player.w / 2, y: groundY,
              vx: rand(-70, 70), vy: rand(-40, -8), life: rand(0.18, 0.36), t: 0 });
          }
        }
        player.y = groundY - player.h;
        vy = 0;
        onGround = true;
        coyote = TUNING.coyote;
      } else {
        onGround = false;
      }

      // spawn + scroll obstacles
      nextGap -= dt;
      if (nextGap <= 0) {
        spawnObstacle();
        nextGap = rand(TUNING.gapMin, TUNING.gapMax);
      }
      for (const o of obstacles) o.x -= speed * dt;
      obstacles = obstacles.filter((o) => o.x + o.w > -40);

      decayDust(dt);

      // collision (forgiving boxes — this is a toy, not a sim)
      const px = player.x + TUNING.hitInsetX;
      const py = player.y + TUNING.hitInsetY;
      const pw = player.w - TUNING.hitInsetX * 2;
      const ph = player.h - TUNING.hitInsetY * 2;
      for (const o of obstacles) {
        if (px < o.x + o.w && px + pw > o.x && py < o.y + o.h && py + ph > o.y) { die(); return; }
      }
    }

    let idleT = 0;

    function decayDust(dt) {
      for (const d of dust) { d.t += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 900 * dt; }
      dust = dust.filter((d) => d.t < d.life);
    }

    /* --- rendering ------------------------------------------------------- */

    function drawSky() {
      const g = ctx.createLinearGradient(0, 0, 0, logicalH);
      g.addColorStop(0, COLORS.sky0);
      g.addColorStop(1, COLORS.sky1);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, LOGICAL_W, logicalH);

      ctx.fillStyle = COLORS.star;
      for (const s of stars) {
        ctx.globalAlpha = s.a;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawHills() {
      for (const h of hills) {
        ctx.fillStyle = h.col;
        ctx.beginPath();
        ctx.moveTo(0, h.y);
        const n = Math.ceil(LOGICAL_W / h.step) + 2;
        const shift = -((h.off % h.step) + h.step);
        for (let i = 0; i <= n; i++) {
          const x = shift + i * h.step;
          ctx.lineTo(x, h.y - h.amp);
          ctx.lineTo(x + h.step / 2, h.y);
        }
        ctx.lineTo(LOGICAL_W, logicalH);
        ctx.lineTo(0, logicalH);
        ctx.closePath();
        ctx.fill();
      }
    }

    function drawGround() {
      ctx.fillStyle = COLORS.ground;
      ctx.fillRect(0, groundY, LOGICAL_W, logicalH - groundY);

      // moving dashes make the speed legible
      const off = scroll % 26;
      ctx.strokeStyle = COLORS.groundLip;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY + 1);
      ctx.lineTo(LOGICAL_W, groundY + 1);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      for (let x = -off; x < LOGICAL_W; x += 26) {
        ctx.moveTo(x, groundY + 12);
        ctx.lineTo(x + 11, groundY + 12);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function drawObstacles() {
      for (const o of obstacles) {
        rounded(ctx, o.x, o.y, o.w, o.h, 5);
        ctx.fillStyle = COLORS.obstacle;
        ctx.fill();
        // a darker notch so silhouettes read at speed
        ctx.fillStyle = COLORS.obstacleInk;
        ctx.globalAlpha = 0.35;
        rounded(ctx, o.x + o.w * 0.28, o.y + 5, o.w * 0.44, Math.max(4, o.h * 0.18), 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    function drawPlayer() {
      rounded(ctx, player.x, player.y, player.w, player.h, 8);
      ctx.fillStyle = COLORS.player;
      ctx.fill();

      // eye looks the way we're heading
      ctx.fillStyle = COLORS.playerInk;
      const ex = player.x + player.w - 11;
      const ey = player.y + 10;
      if (state === 'dying') {
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS.playerInk;
        ctx.beginPath();
        ctx.moveTo(ex - 3, ey - 3); ctx.lineTo(ex + 3, ey + 3);
        ctx.moveTo(ex + 3, ey - 3); ctx.lineTo(ex - 3, ey + 3);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(ex, ey, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawDust() {
      ctx.fillStyle = COLORS.dust;
      for (const d of dust) {
        ctx.globalAlpha = Math.max(0, 1 - d.t / d.life) * 0.8;
        ctx.fillRect(d.x, d.y, 3, 3);
      }
      ctx.globalAlpha = 1;
    }

    function render() {
      ctx.save();
      if (shake > 0.3) ctx.translate(rand(-shake, shake) * 0.4, rand(-shake, shake) * 0.4);
      drawSky();
      drawHills();
      drawGround();
      drawObstacles();
      drawPlayer();
      drawDust();
      ctx.restore();
    }

    /* --- main loop ------------------------------------------------------- */

    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (!lastT) lastT = t;
      let dt = (t - lastT) / 1000;
      lastT = t;
      if (paused) return;
      if (dt > 0.05) dt = 0.05;           // clamp after a stall so we never tunnel
      update(dt);
      render();
    }

    /* --- boot ------------------------------------------------------------ */

    resize();
    bind(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 120));
    bestEl.textContent = 'best ' + best;
    raf = requestAnimationFrame(frame);

    if (AUTOSTART) start();

    // PWA: register the service worker (no-op where unsupported/insecure)
    if ('serviceWorker' in navigator && window.isSecureContext) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }

    return {
      // exposed for the learning rig: poke at it from the console / CDP
      state: () => state,
      start, resize,
      autopilot: AUTOPILOT,
      get score() { return score; },
      destroy() {
        bind(false);
        cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }

  return { create, TUNING };
})();

/* --- Blaze mount -------------------------------------------------------- */
/* Guarded so a re-render doesn't stack a second rAF loop on the same canvas. */

if (typeof Template !== 'undefined') {
  Template.ApplicationHome.onRendered(function () {
    const el = this.$('#hoppa')[0] || document.getElementById('hoppa');
    if (!el || el.dataset.hoppaMounted === '1') return;
    el.dataset.hoppaMounted = '1';

    const inst = Hoppa.create(el);
    window.HOPPA = inst;   // debug handle: window.HOPPA.state()
  });
}
