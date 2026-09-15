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
 * CONTROLS
 *   tap                 short hop
 *   press and hold      higher — the jump is cut short on release
 *   tap again in the air  double jump
 *   land on a rainbow   big bounce
 *   floaters (violet)   pass UNDER them. A full jump will hit one.
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
  const TAP_MS = 140;             // below this a press counts as a "tap" for feel tuning

  const TUNING = {
    gravity: 2300,               // units/s^2
    // A tap IS the minimum jump and holding ADDS height. The earlier design
    // gave the player a big impulse and CUT it on release — which meant a
    // late or missed pointerup silently turned every tap into a full hold.
    // (Measured: a 45ms tap reached the uncut-boost height of 135u.) Building
    // the minimum in makes the control robust: a missed release degrades into
    // a higher jump, never a broken one.
    jumpVelocity: -560,          // a tap: apex ~68u
    holdBoost: 1800,             // gravity while held = 2300-1800 = 500
    holdMax: 0.25,               // seconds the lift may apply: apex ~165u
    airJumps: 1,                 // one extra jump per airtime => "double jump"
    bounceVelocity: -1250,       // a "mad bounce" off a rainbow platform
    bounceBonus: 25,             // score awarded per rainbow
    coyote: 0.09,                // grace after leaving the ground
    buffer: 0.11,                // grace for a tap landing just before touch-down
    speedStart: 250,
    speedMax: 700,
    speedRamp: 11,               // units/s gained per second survived
    gapMin: 0.46,                // tight on purpose: this is meant to be hard
    gapMax: 0.85,                // spawn gaps in seconds-at-current-speed
    // clusters: a tight run of boxes that wants one long jump or air jumps
    clusterChance: 0.40,
    clusterExtra: 2,             // up to 2 more boxes in the run
    clusterGapMin: 0.10,         // SECONDS between members, so difficulty holds
    clusterGapMax: 0.20,         // as the scroll speeds up (a pixel gap would get easier)
    groundH: 84,
    // Height floor for the visible play area. When the viewport is too short to
    // honour it (any landscape phone), the world gets WIDER instead of shorter,
    // and `wScale` re-times the scroll so a corridor still takes the same number
    // of seconds to cross. Difficulty is therefore orientation-independent.
    minLogicalH: 320,
    // Scoring: points come ONLY from airtime, in proportion to height. This
    // re-frames the whole game — you want to be airborne, high, and for as long
    // as possible. What stops that being free is the floaters, which occupy the
    // air; and rainbow bounces, which throw you straight through their band.
    scorePerUnitSecond: 0.35,
    // Pickups grant extra air jumps for the rest of the run.
    airJumpMax: 6,
    orbHeight: [70, 130],        // reachable band above the ground
    // Orb effects — these change the run on the fly.
    slowFactor: 0.55,            // world scroll multiplier while slow is up
    slowDuration: 5,             // seconds
    springJump: 1.25,            // jump impulse multiplier while spring is up
    springBounce: 1.18,          // rainbow bounce multiplier
    springDuration: 6,
    // Lateral control by device tilt. With the device LEVEL (gamma near 0) HOPPA
    // sits in the MIDDLE of the corridor — koad's call, and it makes tilt the
    // primary verb rather than a nudge. Retreating left buys reaction time;
    // there is deliberately less room to the right, so pushing forward is the
    // riskier choice.
    playerX: 200,                // level-device rest = centre of the corridor
    playerXMin: 32,
    playerXMax: 250,
    tiltTravel: 160,             // how far a full tilt slides it
    tiltDeadzone: 3,             // degrees of slop before it reacts
    tiltRange: 20,               // degrees of tilt for full deflection (at sens 1)
    tiltSmooth: 420,             // units/s the player slides laterally
    tiltInvert: false,           // flip if left/right feels backwards on a device
    playerW: 30,
    playerH: 30,
    hitInsetX: 3,
    hitInsetY: 4,
    landTolerance: 16,           // how "on top" you must be to land on a rainbow
    deathHold: 0.55              // seconds of death animation before the overlay
  };

  /* Obstacle archetypes.
   *   ground: sits on the floor, must be jumped
   *   float:  hangs in the air; the gap beneath is the safe line
   *   bounce: landable on top -> big bounce + score
   */
  const TYPES = {
    block:   { weight: 30, kind: 'ground', w: [18, 24], h: [42, 54] },
    tall:    { weight: 16, kind: 'ground', w: [13, 17], h: [62, 78] },
    low:     { weight: 18, kind: 'ground', w: [34, 48], h: [20, 28] },
    // clearance is DERIVED, not guessed: it must sit above the apex of a tap
    // and below the apex of a held jump, or the floater is simply unfair
    // (unavoidable if you happen to be airborne). Measured: tap ~85u, held
    // ~165u, player 30u tall -> the safe band is 115..191.
    float:   { weight: 16, kind: 'float',  w: [22, 34], h: [22, 30], clearance: 145 },
    rainbow: { weight: 12, kind: 'bounce', w: [30, 40], h: [26, 34] },
    // ROUND = collectible. Squares are the things that hurt you; if it is a
    // circle, fly into it. That is the whole instruction set.
    orb:     { weight: 16, kind: 'orb',    w: [22, 26], h: [22, 26] }
  };

  /** The round ones. Each changes the run in a different way, on the fly. */
  const ORBS = {
    jump:   { color: '#8ef5b0', glyph: 'plus',  label: '+jump' },
    slow:   { color: '#7fd4ff', glyph: 'bars',  label: 'slow' },
    spring: { color: '#ffd166', glyph: 'chev',  label: 'spring' }
  };
  const ORB_KEYS = Object.keys(ORBS);
  const TYPE_KEYS = Object.keys(TYPES);
  const WEIGHT_TOTAL = TYPE_KEYS.reduce((n, k) => n + TYPES[k].weight, 0);

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
    block: '#ffb454',
    blockInk: '#5a3608',
    tall: '#ff8a5c',
    tallInk: '#5a2408',
    low: '#ff6b8a',
    lowInk: '#5a0f22',
    float: '#b28cff',
    floatInk: '#2a1b52',
    dust: 'rgba(87,226,200,0.55)',
    bounce: '#ffe9a3',
    orb: '#8ef5b0',
    blood: '#b3162a',
    bloodDeep: '#7d0f1e',
    bloodLight: '#e8556b'
  };

  /* Themes. Only the scenery and the player change — the HAZARD palette stays
   * fixed on purpose, because "squares hurt, circles help" is the entire
   * instruction set and a theme must never blur it. */
  const THEMES = {
    midnight: { sky0: '#0b1020', sky1: '#141d38', hillFar: '#182443', hillNear: '#1d2b50',
                ground: '#243357', lip: '#57e2c8', player: '#57e2c8', ink: '#06202a',
                accent: '#57e2c8', warn: '#ffb454', bg: '#0b1020', text: '#e8f0ff' },
    sunset:   { sky0: '#2a1230', sky1: '#5c2540', hillFar: '#3d1c38', hillNear: '#4e2440',
                ground: '#3a1f3a', lip: '#ffb454', player: '#ffb454', ink: '#3a1a06',
                accent: '#ff8a5c', warn: '#ffd166', bg: '#2a1230', text: '#ffe9d6' },
    forest:   { sky0: '#06140f', sky1: '#103024', hillFar: '#0c2018', hillNear: '#143026',
                ground: '#17352a', lip: '#6ee7a8', player: '#a8e6a0', ink: '#04231a',
                accent: '#6ee7a8', warn: '#ffd166', bg: '#06140f', text: '#e2fff2' },
    neon:     { sky0: '#150a2e', sky1: '#2b1050', hillFar: '#241047', hillNear: '#301659',
                ground: '#2a1550', lip: '#ff5cf0', player: '#ff5cf0', ink: '#2a0630',
                accent: '#ff5cf0', warn: '#ffd166', bg: '#150a2e', text: '#f7e9ff' }
  };
  const THEME_KEYS = Object.keys(THEMES);

  /** Push a theme into the canvas palette and the CSS custom properties, so the
   *  DOM chrome (HUD, overlays, board) moves with the canvas. */
  function applyTheme(name) {
    const t = THEMES[name] || THEMES.midnight;
    COLORS.sky0 = t.sky0;
    COLORS.sky1 = t.sky1;
    COLORS.hillFar = t.hillFar;
    COLORS.hillNear = t.hillNear;
    COLORS.ground = t.ground;
    COLORS.groundLip = t.lip;
    COLORS.player = t.player;
    COLORS.playerInk = t.ink;
    if (typeof document !== 'undefined' && document.documentElement) {
      const root = document.documentElement.style;
      root.setProperty('--bg', t.bg);
      root.setProperty('--ink', t.text);
      root.setProperty('--accent', t.accent);
      root.setProperty('--warn', t.warn);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t.bg);
    }
    return name in THEMES ? name : 'midnight';
  }

  /* --- tiny helpers ------------------------------------------------------ */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function weightedType() {
    let r = Math.random() * WEIGHT_TOTAL;
    for (const k of TYPE_KEYS) { r -= TYPES[k].weight; if (r <= 0) return k; }
    return 'block';
  }

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
      doubleJump: () => blip(760, 0.09, 'square', 0.045),
      bounce: () => { blip(980, 0.10, 'square', 0.05); setTimeout(() => blip(1320, 0.12, 'square', 0.04), 70); },
      pickup: () => { blip(1180, 0.07, 'triangle', 0.05); setTimeout(() => blip(1560, 0.09, 'triangle', 0.04), 60); },
      orb: (kind) => {
        const base = kind === 'slow' ? 620 : kind === 'spring' ? 880 : 1180;
        blip(base, 0.08, 'triangle', 0.05);
        setTimeout(() => blip(base * 1.5, 0.10, 'triangle', 0.04), 65);
      },
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
    const airEl = root.querySelector('#hoppa-air');
    const fxEl = root.querySelector('#hoppa-fx');
    const ctaEl = root.querySelector('#hoppa-cta');
    const subEl = root.querySelector('#hoppa-sub');
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    const sfx = makeBlipper();

    // view state
    let scale = 1, dpr = 1, logicalH = 800, groundY = 0, viewW = 400, wScale = 1;
    let paused = false, raf = 0, lastT = 0;

    // game state
    let state = 'ready';         // ready | playing | dying | over
    let deadFor = 0;
    let vy = 0, onGround = true, holding = false, boostLeft = 0;
    let coyote = 0, jumpBuffered = 0, jumpsLeft = 0;
    let speed = TUNING.speedStart, distance = 0, bonus = 0, score = 0, scroll = 0, clock = 0;
    // points earned from airtime*height; `bonus` is the rainbow/bounce money
    let airScore = 0, airJumpStock = 1, wasScoring = false;
    // orb effects, in game-clock seconds
    let slowUntil = 0, springUntil = 0, effSpeed = TUNING.speedStart, hudFx = '';
    let worldDrift = 0;   // how fast scenery and gore move; 0 once you are dead
    let tiltSens = 1;     // settings: higher = reacts to a smaller tilt
    let faceImg = null;   // settings: the player's own face, if they gave us one
    let obstacles = [], dust = [], rings = [], shake = 0;
    // death gore: an expanding puddle plus flying droplets, both anchored to the
    // world so they scroll away with the ground rather than hanging in the air
    let puddles = [], blood = [];
    let hills = [], stars = [];
    let pressAt = 0, lastHoldMs = 0;
    // feel telemetry — surfaced through the debug API for the test tools
    let statJumps = 0, statBounces = 0, statApex = 0;
    let statPicked = 0;
    let statTypes = {};
    let statOrbs = {};
    let best = 0;
    try { best = parseInt(localStorage.getItem(STORAGE_BEST) || '0', 10) || 0; } catch (e) { best = 0; }

    const player = { x: TUNING.playerX, y: 0, w: TUNING.playerW, h: TUNING.playerH };

    /* Headless / CI hooks. A game has no server-side surface to curl, which
     * makes it the hardest thing in a stack to smoke-test. These flags make the
     * runtime assertable from a headless browser:
     *
     *   ?autostart=1   skip the ready screen and begin playing
     *   ?autopilot=1   implies autostart, and plays for itself
     *   ?sandbox=1     no obstacles spawn; for measuring jump feel in isolation
     *
     * CI assertion: with ?autopilot=1 the score must be > 0 after a few seconds
     * of virtual time — which proves rAF, physics, obstacle spawning and
     * scoring all ran. See tools/smoke.mjs and tools/feel.mjs.
     */
    const params = (() => {
      try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(''); }
    })();
    const truthyFlag = (v) => v != null && ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
    const AUTOPILOT = truthyFlag(params.get('autopilot'));
    const AUTOSTART = AUTOPILOT || truthyFlag(params.get('autostart'));
    const SANDBOX = truthyFlag(params.get('sandbox'));
    const ONLY = params.get('only');      // force one archetype (testing)

    /* --- layout ---------------------------------------------------------- */

    function resize() {
      const cssW = root.clientWidth || window.innerWidth;
      const cssH = root.clientHeight || window.innerHeight;
      dpr = clamp(window.devicePixelRatio || 1, 1, 3);
      // Fit the nominal 400-unit corridor to the width, but never let the visible
      // height fall below minLogicalH — otherwise a landscape phone leaves only a
      // ~185-unit play area and every jump exits the screen.
      const fitW = cssW / LOGICAL_W;
      const fitH = cssH / TUNING.minLogicalH;
      scale = Math.min(fitW, fitH);
      wScale = Math.max(1, (cssW / scale) / LOGICAL_W);
      viewW = LOGICAL_W * wScale;

      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      logicalH = cssH / scale;
      groundY = logicalH - TUNING.groundH;

      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);

      player.y = groundY - player.h;
      player.x = clamp(player.x, TUNING.playerXMin * wScale, TUNING.playerXMax * wScale);

      stars = Array.from({ length: 46 }, () => ({
        x: rand(0, viewW), y: rand(0, logicalH * 0.72),
        r: rand(0.5, 1.5), a: rand(0.15, 0.7)
      }));
      hills = [
        { y: groundY, amp: rand(70, 110), step: 190, off: 0, spd: 0.10, col: COLORS.hillFar },
        { y: groundY, amp: rand(46, 70),  step: 150, off: 0, spd: 0.22, col: COLORS.hillNear }
      ];
    }

    /* --- input ----------------------------------------------------------- */

    function press() {
      // settings is a pause menu: no input should reach the game while it is up
      if (globalThis.HoppaSettings && HoppaSettings.isOpen && HoppaSettings.isOpen()) return;
      // never restart the run while the arcade initials entry is up: the player
      // is tapping letters, not the canvas
      if (state === 'over' && globalThis.HoppaScoreUI && HoppaScoreUI.isEntryOpen && HoppaScoreUI.isEntryOpen()) return;
      if (state === 'ready' || state === 'over') { enableTilt(); start(); return; }
      if (state !== 'playing') return;
      enableTilt();                 // iOS needs a gesture; this is one
      holding = true;
      pressAt = clock;
      jumpBuffered = TUNING.buffer;
      tryJump();
    }

    function release() {
      holding = false;          // no cut: the minimum jump is built into jumpVelocity
      lastHoldMs = Math.round((clock - pressAt) * 1000);
    }

    function doJump(air) {
      vy = TUNING.jumpVelocity * (springActive() ? TUNING.springJump : 1);
      onGround = false;
      coyote = 0;
      boostLeft = TUNING.holdMax;
      statJumps++;
      if (air) {
        sfx.doubleJump();
        rings.push({ x: player.x + player.w / 2, y: player.y + player.h / 2, t: 0, life: 0.32, r0: 6, r1: 34 });
      } else {
        sfx.jump();
      }
      for (let i = 0; i < 6; i++) {
        dust.push({ x: player.x + player.w / 2, y: air ? player.y + player.h : groundY,
          vx: rand(-40, 10), vy: rand(-70, -15), life: rand(0.25, 0.5), t: 0 });
      }
    }

    function tryJump() {
      if (onGround || coyote > 0) {
        jumpsLeft = airJumpStock;    // ground jump, then whatever we have banked
        doJump(false);
        jumpBuffered = 0;
      } else if (jumpsLeft > 0) {
        jumpsLeft--;
        doJump(true);
        jumpBuffered = 0;
      }
      // otherwise: leave jumpBuffered armed so a landing consumes it
    }

    const onPointerDown = (e) => {
      e.preventDefault();
      // Pointer capture matters more than it looks: without it, a finger that
      // lifts outside the canvas — or a fast tap that drifts — never delivers
      // pointerup, so release() never runs and the jump is never cut. That
      // silently turns every tap into a full hold, which is exactly the bug
      // tools/feel.mjs caught. Capture plus a WINDOW-level release makes the
      // short jump reliable on real hardware.
      try { if (e.pointerId != null && root.setPointerCapture) root.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      press();
    };
    const onPointerUp = (e) => { if (e.cancelable) e.preventDefault(); release(); };
    const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];
    const onKeyDown = (e) => {
      if (JUMP_KEYS.includes(e.code)) { e.preventDefault(); if (!e.repeat) press(); return; }
      // keyboard fallback so lateral control is usable without a gyro
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        tiltKey = e.code === 'ArrowLeft' ? -1 : 1;
      }
    };
    const onKeyUp = (e) => {
      if (JUMP_KEYS.includes(e.code)) { e.preventDefault(); release(); return; }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); tiltKey = 0; }
    };

    function bind(flag) {
      const fn = flag ? 'addEventListener' : 'removeEventListener';
      root[fn]('pointerdown', onPointerDown, { passive: false });
      // release is bound to the window: the finger can leave the canvas mid-tap
      window[fn]('pointerup', onPointerUp, { passive: false });
      window[fn]('pointercancel', onPointerUp, { passive: false });
      window[fn]('keydown', onKeyDown);
      window[fn]('keyup', onKeyUp);
    }

    /* --- lateral control (device tilt) -----------------------------------
     * gamma is the left/right roll of the device. iOS gates it behind a
     * user-gesture permission prompt, so we ask lazily on the first tap — the
     * same tap that starts the game. If it is denied, unsupported, or this is
     * a desktop, tilt stays 0 and the game is entirely playable: the player
     * just does not slide. Never block the game on a sensor.
     * ------------------------------------------------------------------- */
    let tiltRaw = 0;          // degrees, remapped for screen rotation
    let tiltInput = 0;        // -1..1 after deadzone + invert
    let tiltTest = null;      // test affordance: HOPPA.setTilt(0.8)
    let tiltKey = 0;          // keyboard fallback
    let tiltEnabled = false;
    let tiltSeen = false;

    function remapTilt(e) {
      const g = e.gamma, b = e.beta;
      if (g == null) return 0;
      const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      if (angle === 90) return b;
      if (angle === -90 || angle === 270) return -b;
      if (angle === 180) return -g;
      return g;
    }

    const onOrient = (e) => { tiltSeen = true; tiltRaw = remapTilt(e); };

    function enableTilt() {
      if (tiltEnabled) return;
      const DOE = window.DeviceOrientationEvent;
      if (!DOE) return;
      const attach = () => {
        window.addEventListener('deviceorientation', onOrient, true);
        tiltEnabled = true;
      };
      try {
        if (typeof DOE.requestPermission === 'function') {
          DOE.requestPermission().then((res) => { if (res === 'granted') attach(); }).catch(() => {});
        } else {
          attach();
        }
      } catch (err) { /* no sensor is not an error */ }
    }

    function tiltToUnit(deg) {
      const a = Math.abs(deg);
      if (a <= TUNING.tiltDeadzone) return 0;
      const range = Math.max(2, TUNING.tiltRange / Math.max(0.2, tiltSens));
      const t = Math.min(1, (a - TUNING.tiltDeadzone) / range);
      return Math.sign(deg) * t;
    }

    /** Slide the player toward wherever the device is tilted. Rate-limited
     *  rather than eased so the control feels direct instead of floaty. */
    function updateLateral(dt) {
      let want;
      if (tiltTest != null) want = tiltTest;
      else if (tiltEnabled && tiltSeen) want = tiltToUnit(tiltRaw) * (TUNING.tiltInvert ? -1 : 1);
      else want = tiltKey;

      tiltInput = clamp(want, -1, 1);
      // ranges are expressed for the 400-unit corridor and scaled with it, so the
      // control feels the same in either orientation
      const target = clamp((TUNING.playerX + tiltInput * TUNING.tiltTravel) * wScale,
        TUNING.playerXMin * wScale, TUNING.playerXMax * wScale);
      const step = TUNING.tiltSmooth * wScale * dt;
      player.x += clamp(target - player.x, -step, step);
    }

    const onVisibility = () => {
      paused = document.hidden;
      if (!paused) { lastT = 0; }
    };

    /* --- lifecycle ------------------------------------------------------- */

    let nextGap = 0.9;

    function start() {
      state = 'playing';
      vy = 0; onGround = true; holding = false; boostLeft = 0;
      coyote = 0; jumpBuffered = 0;
      speed = TUNING.speedStart; distance = 0; bonus = 0; score = 0;
      airScore = 0; airJumpStock = 1; wasScoring = false;
      slowUntil = 0; springUntil = 0; hudFx = '';
      jumpsLeft = airJumpStock;
      obstacles = []; dust = []; rings = []; shake = 0; deadFor = 0;
      puddles = []; blood = [];
      statJumps = 0; statBounces = 0; statApex = 0; statTypes = {}; statPicked = 0;
      statOrbs = {};
      pendingType = null;
      nextGap = 0.9;
      player.y = groundY - player.h;
      scoreEl.textContent = '0';
      scoreEl.classList.remove('is-scoring');
      syncHud();
      if (globalThis.HoppaScoreUI && HoppaScoreUI.gameStarted) HoppaScoreUI.gameStarted();
      overlay.classList.add('is-hidden');
      lastT = 0;
    }

    /** Points are airtime-based now, so the banked air jumps are worth showing. */
    function syncHud() {
      if (!airEl) return;
      airEl.textContent = 'jumps x' + airJumpStock;
      airEl.classList.toggle('is-stocked', airJumpStock > 1);
    }

    function die() {
      state = 'dying';
      deadFor = 0;
      shake = 14;
      sfx.die();

      // a puddle that spreads and settles. Blobs rather than one ellipse, so the
      // outline reads as liquid instead of a geometric circle.
      puddles.push({
        x: player.x + player.w / 2,
        y: groundY,
        t: 0,
        life: 1.7,
        blobs: Array.from({ length: 6 }, () => ({
          dx: rand(-18, 18), dy: rand(-3.5, 3.5),
          r: rand(6, 13), grow: rand(0.7, 1.3)
        }))
      });

      for (let i = 0; i < 22; i++) {
        blood.push({
          x: player.x + player.w / 2 + rand(-8, 8),
          y: player.y + player.h * rand(0.25, 1),
          vx: rand(-180, 180), vy: rand(-340, -40),
          r: rand(1.4, 3.4), life: rand(0.45, 0.95), t: 0
        });
      }

      for (let i = 0; i < 12; i++) {
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
      subEl.textContent = 'score ' + score + (statBounces ? '  ·  ' + statBounces + ' bounce' + (statBounces > 1 ? 's' : '') : '');
      overlay.classList.remove('is-hidden');
      // hand off to the score UI, which may take over the CTA with the entry
      if (globalThis.HoppaScoreUI && HoppaScoreUI.gameOver) HoppaScoreUI.gameOver(score, statBounces);
    }

    /* --- simulation ------------------------------------------------------ */

    let pendingType = null;

    /** Vertical placement per archetype. */
    function placeY(spec, h) {
      if (spec.kind === 'float') return groundY - spec.clearance - h;
      if (spec.kind === 'orb') return groundY - rand(TUNING.orbHeight[0], TUNING.orbHeight[1]) - h;
      return groundY - h;
    }

    function makeObstacle(type) {
      const spec = TYPES[type];
      const w = rand(spec.w[0], spec.w[1]);
      const h = rand(spec.h[0], spec.h[1]);
      statTypes[type] = (statTypes[type] || 0) + 1;
      const o = { type, kind: spec.kind, x: 0, w, h, y: placeY(spec, h), hue: rand(0, 360) };
      if (spec.kind === 'orb') o.orb = pick(ORB_KEYS);
      return o;
    }

    const slowActive = () => clock < slowUntil;
    const springActive = () => clock < springUntil;

    function spawnObstacle() {
      const forced = (ONLY && TYPES[ONLY]) ? ONLY : null;
      const type = forced || pendingType || weightedType();
      const first = makeObstacle(type);
      first.x = viewW + 20;
      obstacles.push(first);

      // Clusters: a tight run of boxes, threaded with one long jump or with air
      // jumps. Member gaps are in SECONDS, not pixels — a fixed pixel gap would
      // get *easier* as the scroll speeds up, which is backwards.
      if (!forced && TYPES[type].kind === 'ground' && Math.random() < TUNING.clusterChance) {
        let cursor = first.x;
        let prevW = first.w;
        const extra = 1 + Math.floor(Math.random() * TUNING.clusterExtra);
        for (let i = 0; i < extra; i++) {
          const t2 = weightedType();
          if (TYPES[t2].kind !== 'ground') break;      // clusters are boxes only
          const m = makeObstacle(t2);
          cursor += prevW + rand(TUNING.clusterGapMin, TUNING.clusterGapMax) * effSpeed;
          m.x = cursor;
          prevW = m.w;
          obstacles.push(m);
        }
      }

      // Decide the NEXT spawn now, so we can reserve landing room for it. A
      // floater is only fair if the player is back on the ground when it
      // arrives — a jump lasts ~0.7s and there is no way to duck in mid-air.
      pendingType = forced || weightedType();
      nextGap = rand(TUNING.gapMin, TUNING.gapMax) + (pendingType === 'float' ? 0.35 : 0);
    }

    /** Plays the game competently so the smoke test can exercise survival.
     *  Speed-invariant: both the trigger gap and the airtime scale with the
     *  scroll speed, so one threshold works from the first obstacle to the last.
     *  Acts once per obstacle — without that guard it would press every frame
     *  and burn the double jump instantly. */
    let apTarget = null;
    let apDoubleFor = null;
    let apHold = 0;
    function autopilotStep(dt) {
      let next = null;
      for (const o of obstacles) {
        if (o.x + o.w > player.x + player.w && (!next || o.x < next.x)) next = o;
      }
      if (!next) { apTarget = null; apDoubleFor = null; }
      else {
        const gap = next.x - (player.x + player.w);
        if (apTarget !== next) {
          // floaters are passed UNDER and orbs are harmless: the bot only jumps
          // for things that would actually kill it
          if ((next.kind === 'ground' || next.kind === 'bounce') && gap <= effSpeed * 0.42) {
            apTarget = next;
            press();
            // always the full lift. An earlier version tuned this per archetype
            // and the shortest setting left almost no margin, so the bot died
            // on its first obstacle. The autopilot's job is survival, not grace;
            // short hops are exercised by the tap measurement instead.
            apHold = TUNING.holdMax;
          }
        }
      }
      // hold the jump for the duration the archetype needs, then let go
      if (apHold > 0) { apHold -= dt; holding = true; } else { holding = false; }
    }

    function update(dt) {
      clock += dt;
      // Lateral control is frozen once you are dead: otherwise the tilt keeps
      // sliding the body out of its own blood pool, which koad caught.
      if (state === 'ready' || state === 'playing') updateLateral(dt);
      effSpeed = speed * wScale * (slowActive() ? TUNING.slowFactor : 1);
      // The world STOPS when you die. It used to keep drifting at 45%, which slid
      // the blood puddle off screen while the player watched it — koad reported
      // exactly that. Gore rides on worldDrift, so it now holds its ground.
      const drift = state === 'playing'
        ? effSpeed
        : (state === 'ready' ? TUNING.speedStart * 0.45 * wScale : 0);
      worldDrift = drift;
      scroll += drift * dt;

      for (const h of hills) h.off += drift * h.spd * dt;

      if (state === 'ready') {
        idleT += dt;
        player.y = groundY - player.h - Math.sin(idleT * 2.4) * 3;
        decayFx(dt);
        return;
      }

      if (state === 'dying') {
        deadFor += dt;
        shake = Math.max(0, shake - dt * 40);
        player.y = Math.min(groundY - player.h, player.y + 520 * dt);
        decayFx(dt);
        if (deadFor >= TUNING.deathHold) gameOver();
        return;
      }

      if (state === 'over') { shake = Math.max(0, shake - dt * 40); decayFx(dt); return; }

      // --- playing ---
      speed = Math.min(TUNING.speedMax, speed + TUNING.speedRamp * dt);
      distance += speed * dt;
      if (AUTOPILOT) autopilotStep(dt);

      if (jumpBuffered > 0) jumpBuffered -= dt;
      if (coyote > 0) coyote -= dt;

      let g = TUNING.gravity;
      if (holding && boostLeft > 0 && !onGround) {
        g -= TUNING.holdBoost;
        boostLeft -= dt;
      }
      vy += g * dt;
      player.y += vy * dt;

      // apex telemetry (positive = height above the ground line)
      const height = (groundY - player.h) - player.y;
      if (height > statApex) statApex = height;

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
        jumpsLeft = airJumpStock;      // pickups bank for the rest of the run
        coyote = TUNING.coyote;
      } else {
        onGround = false;
      }

      // a buffered tap that arrived just before landing still fires
      if (jumpBuffered > 0 && onGround) tryJump();

      if (!SANDBOX) {
        nextGap -= dt;
        if (nextGap <= 0) spawnObstacle();
      }
      for (const o of obstacles) o.x -= effSpeed * dt;
      obstacles = obstacles.filter((o) => o.x + o.w > -40);

      decayFx(dt);
      collide();

      // Points come ONLY from airtime, in proportion to height. Landing stops
      // the clock, so the game becomes "get up and stay up" — and the floaters
      // hanging in the air are precisely what makes that dangerous. Rainbow
      // bounces pay a flat bonus on top of throwing you through their band.
      // NOTE: `height` is already measured above by the apex telemetry — do not
      // redeclare it here. Shadowing it produced a duplicate-const SyntaxError
      // that took the whole bundle out.
      if (!onGround && height > 0) airScore += height * TUNING.scorePerUnitSecond * dt;
      const newScore = Math.floor(airScore) + bonus;
      if (newScore !== score) { score = newScore; scoreEl.textContent = String(score); }

      const scoring = !onGround && height > 0;
      if (scoring !== wasScoring) {
        wasScoring = scoring;
        scoreEl.classList.toggle('is-scoring', scoring);
      }

      // active orb effects, shown with their remaining time
      const fx = [];
      if (slowActive()) fx.push('slow ' + (slowUntil - clock).toFixed(1) + 's');
      if (springActive()) fx.push('spring ' + (springUntil - clock).toFixed(1) + 's');
      const fxText = fx.join('   \u00b7   ');
      if (fxText !== hudFx) {
        hudFx = fxText;
        if (fxEl) { fxEl.textContent = fxText; fxEl.classList.toggle('is-live', fxText !== ''); }
      }
    }

    let idleT = 0;

    function collide() {
      const px = player.x + TUNING.hitInsetX;
      const py = player.y + TUNING.hitInsetY;
      const pw = player.w - TUNING.hitInsetX * 2;
      const ph = player.h - TUNING.hitInsetY * 2;
      const feet = player.y + player.h;

      for (const o of obstacles) {
        if (!(px < o.x + o.w && px + pw > o.x && py < o.y + o.h && py + ph > o.y)) continue;

        // ROUND objects are collectibles: fly into one and it changes the run
        // on the fly. This is the entire instruction set — squares hurt,
        // circles help.
        if (o.kind === 'orb') {
          o.taken = true;
          statOrbs[o.orb] = (statOrbs[o.orb] || 0) + 1;
          if (o.orb === 'jump') {
            airJumpStock = Math.min(TUNING.airJumpMax, airJumpStock + 1);
            jumpsLeft = Math.min(TUNING.airJumpMax, jumpsLeft + 1);   // usable now
          } else if (o.orb === 'slow') {
            slowUntil = clock + TUNING.slowDuration;
          } else {
            springUntil = clock + TUNING.springDuration;
          }
          statPicked++;
          sfx.orb(o.orb);
          rings.push({ x: o.x + o.w / 2, y: o.y + o.h / 2, t: 0, life: 0.35, r0: 4, r1: 42 });
          syncHud();
          continue;
        }

        if (o.kind === 'bounce') {
          // landable: descending, and arriving from above rather than sideways
          const fromAbove = vy >= 0 && feet - o.y <= TUNING.landTolerance;
          if (fromAbove) {
            player.y = o.y - player.h;
            vy = TUNING.bounceVelocity * (springActive() ? TUNING.springBounce : 1);
            onGround = false;
            jumpsLeft = airJumpStock;
            bonus += TUNING.bounceBonus;
            statBounces++;
            shake = 8;
            sfx.bounce();
            rings.push({ x: player.x + player.w / 2, y: player.y + player.h, t: 0, life: 0.45, r0: 8, r1: 56 });
            for (let i = 0; i < 14; i++) {
              dust.push({ x: player.x + player.w / 2, y: player.y + player.h,
                vx: rand(-150, 150), vy: rand(-220, -40), life: rand(0.3, 0.6), t: 0 });
            }
            continue;                      // bounced — not fatal
          }
        }
        die();
        return;
      }
      obstacles = obstacles.filter((o) => !o.taken);
    }

    function decayFx(dt) {
      for (const d of dust) { d.t += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 900 * dt; }
      dust = dust.filter((d) => d.t < d.life);
      for (const r of rings) r.t += dt;
      rings = rings.filter((r) => r.t < r.life);

      const slide = worldDrift * dt;        // gore is stuck to the ground
      for (const b of blood) {
        b.t += dt;
        b.x += b.vx * dt - slide;
        b.y += b.vy * dt;
        b.vy += 1100 * dt;
        if (b.y > groundY - 1) { b.y = groundY - 1; b.vy = 0; b.vx *= 0.4; }
      }
      blood = blood.filter((b) => b.t < b.life);
      for (const p of puddles) { p.t += dt; p.x -= slide; }
      // puddles are NOT filtered: the blood stays for as long as the game-over
      // screen is up, and start() clears it on retry. Vanishing mid-screen would
      // make the whole thing look like a glitch.
    }

    /* --- rendering ------------------------------------------------------- */

    function drawSky() {
      const g = ctx.createLinearGradient(0, 0, 0, logicalH);
      g.addColorStop(0, COLORS.sky0);
      g.addColorStop(1, COLORS.sky1);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, viewW, logicalH);

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
        const n = Math.ceil(viewW / h.step) + 2;
        const shift = -((h.off % h.step) + h.step);
        for (let i = 0; i <= n; i++) {
          const x = shift + i * h.step;
          ctx.lineTo(x, h.y - h.amp);
          ctx.lineTo(x + h.step / 2, h.y);
        }
        ctx.lineTo(viewW, logicalH);
        ctx.lineTo(0, logicalH);
        ctx.closePath();
        ctx.fill();
      }
    }

    function drawGround() {
      ctx.fillStyle = COLORS.ground;
      ctx.fillRect(0, groundY, viewW, logicalH - groundY);

      const off = scroll % 26;
      ctx.strokeStyle = COLORS.groundLip;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY + 1);
      ctx.lineTo(viewW, groundY + 1);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      for (let x = -off; x < viewW; x += 26) {
        ctx.moveTo(x, groundY + 12);
        ctx.lineTo(x + 11, groundY + 12);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function obstacleFill(o) {
      if (o.type === 'rainbow') {
        // animated so the landable ones are unmistakable at speed
        return 'hsl(' + (((clock * 150 + o.hue) % 360).toFixed(0)) + ' 92% 64%)';
      }
      return COLORS[o.type] || COLORS.block;
    }

    function obstacleInk(o) {
      return COLORS[o.type + 'Ink'] || COLORS.blockInk;
    }

    /** The round ones. Deliberately circular, haloed, and bobbing — the visual
     *  language is "if it is a circle, fly into it". */
    function drawOrb(o) {
      const cfg = ORBS[o.orb] || ORBS.jump;
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2 + Math.sin(clock * 3 + o.hue) * 3;
      const r = o.w / 2;

      ctx.globalAlpha = 0.16 + 0.06 * Math.sin(clock * 4 + o.hue);
      ctx.fillStyle = cfg.color;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.75, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = cfg.color;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.sky0;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = cfg.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      if (cfg.glyph === 'plus') {
        ctx.moveTo(cx, cy - r * 0.34); ctx.lineTo(cx, cy + r * 0.34);
        ctx.moveTo(cx - r * 0.34, cy); ctx.lineTo(cx + r * 0.34, cy);
      } else if (cfg.glyph === 'bars') {
        ctx.moveTo(cx - r * 0.34, cy - r * 0.14); ctx.lineTo(cx + r * 0.34, cy - r * 0.14);
        ctx.moveTo(cx - r * 0.34, cy + r * 0.18); ctx.lineTo(cx + r * 0.34, cy + r * 0.18);
      } else {
        ctx.moveTo(cx - r * 0.34, cy + r * 0.12);
        ctx.lineTo(cx, cy - r * 0.3);
        ctx.lineTo(cx + r * 0.34, cy + r * 0.12);
      }
      ctx.stroke();
    }

    function drawObstacles() {
      for (const o of obstacles) {
        if (o.kind === 'orb') { drawOrb(o); continue; }
        // hazards stay BLOCKY on purpose: squares are what you avoid
        rounded(ctx, o.x, o.y, o.w, o.h, o.kind === 'bounce' ? 6 : 3);
        ctx.fillStyle = obstacleFill(o);
        ctx.fill();

        if (o.kind === 'bounce') {
          // a bright lip on the landing surface, so "you can stand here" reads
          ctx.save();
          rounded(ctx, o.x, o.y, o.w, o.h, 7);
          ctx.clip();
          ctx.fillStyle = COLORS.bounce;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(o.x, o.y, o.w, 5);
          ctx.globalAlpha = 1;
          ctx.restore();
        } else {
          ctx.fillStyle = obstacleInk(o);
          ctx.globalAlpha = 0.35;
          rounded(ctx, o.x + o.w * 0.28, o.y + 5, o.w * 0.44, Math.max(4, o.h * 0.18), 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        if (o.kind === 'float') {
          // a faint tether to the ground reads as "the gap is the path"
          ctx.strokeStyle = COLORS.float;
          ctx.globalAlpha = 0.12;
          ctx.setLineDash([4, 6]);
          ctx.beginPath();
          ctx.moveTo(o.x + o.w / 2, o.y + o.h);
          ctx.lineTo(o.x + o.w / 2, groundY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
    }

    function drawPlayer() {
      // spring is visible on the player, so the effect is never invisible
      if (springActive()) {
        ctx.globalAlpha = 0.45 + 0.2 * Math.sin(clock * 8);
        ctx.strokeStyle = ORBS.spring.color;
        ctx.lineWidth = 2;
        rounded(ctx, player.x - 4, player.y - 4, player.w + 8, player.h + 8, 12);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // If the player gave us a selfie, that IS the hoppa. Clipped to the same
      // rounded box and ringed in the theme colour so it still reads as a piece
      // rather than a photo pasted on the canvas.
      const hasFace = !!(faceImg && faceImg.complete && faceImg.naturalWidth);

      rounded(ctx, player.x, player.y, player.w, player.h, 8);
      if (hasFace) {
        ctx.save();
        rounded(ctx, player.x, player.y, player.w, player.h, 8);
        ctx.clip();
        ctx.drawImage(faceImg, player.x, player.y, player.w, player.h);
        ctx.restore();
        rounded(ctx, player.x, player.y, player.w, player.h, 8);
        ctx.strokeStyle = COLORS.player;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = COLORS.player;
        ctx.fill();
      }

      ctx.fillStyle = COLORS.playerInk;
      const ex = player.x + player.w - 11;
      const ey = player.y + 10;
      if (state === 'dying') {
        ctx.lineWidth = 2;
        // X eyes in white over a face, otherwise they vanish into skin tones
        ctx.strokeStyle = hasFace ? '#ffffff' : COLORS.playerInk;
        ctx.beginPath();
        ctx.moveTo(ex - 3, ey - 3); ctx.lineTo(ex + 3, ey + 3);
        ctx.moveTo(ex + 3, ey - 3); ctx.lineTo(ex - 3, ey + 3);
        ctx.stroke();
      } else {
        // the eye is meaningless on a real face
        if (!hasFace) {
          ctx.beginPath();
          ctx.arc(ex, ey, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        // one dot per banked air jump, so orb upgrades are legible at a glance
        const n = Math.min(jumpsLeft, TUNING.airJumpMax);
        if (!onGround && n > 0) {
          ctx.globalAlpha = 0.9;
          for (let i = 0; i < n; i++) {
            ctx.beginPath();
            ctx.arc(player.x + player.w / 2 - ((n - 1) * 5) / 2 + i * 5, player.y - 9, 2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    /** The death puddle. Drawn on the ground before the obstacles so things
     *  passing over it occlude correctly. */
    function drawPuddles() {
      for (const p of puddles) {
        const k = Math.min(1, p.t / p.life);
        const ease = 1 - Math.pow(1 - k, 3);
        ctx.fillStyle = COLORS.blood;
        ctx.globalAlpha = 0.9;
        for (const b of p.blobs) {
          const r = b.r * (0.3 + ease * b.grow);
          ctx.beginPath();
          ctx.ellipse(p.x + b.dx * (0.35 + ease * 0.9), p.y + b.dy,
            r, r * 0.42, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // a deeper core so it reads as liquid with depth, not a flat decal
        ctx.fillStyle = COLORS.bloodDeep;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 9 * ease + 2, 4 * ease + 1, 0, 0, Math.PI * 2);
        ctx.fill();
        // wet highlight
        ctx.fillStyle = COLORS.bloodLight;
        ctx.globalAlpha = 0.28 * ease;
        ctx.beginPath();
        ctx.ellipse(p.x - 7, p.y - 2.5, 4.5 * ease + 1.5, 1.8 * ease + 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    function drawFx() {
      // blood first, so the bright dust sits on top of it
      for (const b of blood) {
        ctx.globalAlpha = Math.max(0, 1 - (b.t / b.life) * 0.6);
        ctx.fillStyle = COLORS.blood;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      ctx.fillStyle = COLORS.dust;
      for (const d of dust) {
        ctx.globalAlpha = Math.max(0, 1 - d.t / d.life) * 0.8;
        ctx.fillRect(d.x, d.y, 3, 3);
      }
      ctx.globalAlpha = 1;
      for (const r of rings) {
        const k = r.t / r.life;
        ctx.globalAlpha = Math.max(0, 1 - k) * 0.8;
        ctx.strokeStyle = COLORS.bounce;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function render() {
      ctx.save();
      if (shake > 0.3) ctx.translate(rand(-shake, shake) * 0.4, rand(-shake, shake) * 0.4);
      drawSky();
      // a cool wash while the world is slowed — the effect should be felt
      if (slowActive()) {
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = ORBS.slow.color;
        ctx.fillRect(0, 0, viewW, logicalH);
        ctx.globalAlpha = 1;
      }
      drawHills();
      drawGround();
      drawPuddles();
      drawObstacles();
      drawPlayer();
      drawFx();
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
      get bonus() { return bonus; },
      // feel telemetry — tools/feel.mjs asserts on these
      stats: () => ({
        score, bonus, jumps: statJumps, bounces: statBounces,
        picked: statPicked, airJumpStock, airScore: Math.floor(airScore),
        orbs: Object.assign({}, statOrbs),
        slow: Math.max(0, Number((slowUntil - clock).toFixed(1))),
        spring: Math.max(0, Number((springUntil - clock).toFixed(1))),
        effSpeed: Math.round(effSpeed),
        viewW: Math.round(viewW),
        logicalH: Math.round(logicalH),
        wScale: Number(wScale.toFixed(3)),
        groundY: Math.round(groundY),
        orientation: viewW > logicalH ? 'landscape' : 'portrait',
        apex: Math.round(statApex), onGround, jumpsLeft,
        paused,
        height: Math.round((groundY - player.h) - player.y),
        obstacles: obstacles.length,
        types: Object.assign({}, statTypes),
        tilt: Number(tiltInput.toFixed(3)),
        tiltSeen,
        holdMs: lastHoldMs,
        playerX: Math.round(player.x * 10) / 10
      }),
      typeWeights: () => TYPES,
      tuning: () => TUNING,
      themes: () => THEMES,
      setTheme(name) {
        const applied = applyTheme(name);
        resize();                    // hills cache their colour, so re-derive
        return applied;
      },
      setTiltSensitivity(v) {
        tiltSens = clamp(Number(v) || 1, 0.4, 3);
        return tiltSens;
      },
      /** Settings opens over a live run, so it needs to stop the simulation
       *  without pretending the tab was hidden. */
      setPaused(v) {
        paused = !!v;
        if (!paused) lastT = 0;      // drop the gap so there is no time jump
        return paused;
      },
      /** data URL from the settings page; null clears it. */
      setFace(dataUrl) {
        if (!dataUrl) { faceImg = null; return false; }
        const img = new Image();
        img.src = dataUrl;
        faceImg = img;
        return true;
      },
      /** Whether a face texture is decoded and ready to draw. */
      hasFace: () => !!(faceImg && faceImg.complete && faceImg.naturalWidth),
      // Test affordance: drive the lateral control with no gyro present.
      setTilt(v) { tiltTest = v == null ? null : clamp(v, -1, 1); return tiltTest; },
      invertTilt(on) { TUNING.tiltInvert = on == null ? !TUNING.tiltInvert : !!on; return TUNING.tiltInvert; },
      // Deterministic spawn-distribution probe: proves every archetype is
      // reachable without waiting for a lucky roll in a real run (the in-run
      // histogram is inherently flaky for the rarer types).
      roll(n) {
        const h = {};
        const N = n || 1000;
        for (let i = 0; i < N; i++) { const t = weightedType(); h[t] = (h[t] || 0) + 1; }
        return h;
      },
      // Test affordance: drop an obstacle at the player. tools/feel.mjs uses this
      // to exercise the rainbow landing rule deterministically, instead of
      // hoping a random spawn lines up during a play-through.
      place(type, dx, topOffset, orb) {
        const spec = TYPES[type];
        if (!spec) return false;
        const w = (spec.w[0] + spec.w[1]) / 2;
        const h = (spec.h[0] + spec.h[1]) / 2;
        obstacles.push({
          type, kind: spec.kind,
          x: player.x + (dx || 0),
          w, h,
          y: (player.y + player.h) - (topOffset == null ? 10 : topOffset),
          hue: 0,
          orb: spec.kind === 'orb' ? (orb || 'jump') : undefined
        });
        return true;
      },
      destroy() {
        bind(false);
        cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }

  return { create, TUNING, TYPES };
})();

/* --- Blaze mount -------------------------------------------------------- */
/* Guarded so a re-render doesn't stack a second rAF loop on the same canvas. */

if (typeof Template !== 'undefined') {
  Template.ApplicationHome.onRendered(function () {
    const el = this.$('#hoppa')[0] || document.getElementById('hoppa');
    if (!el || el.dataset.hoppaMounted === '1') return;
    el.dataset.hoppaMounted = '1';

    const inst = Hoppa.create(el);
    window.HOPPA = inst;   // debug handle: window.HOPPA.stats()
  });
}
