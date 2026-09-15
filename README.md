# HOPPA — the koad:io mobile rig

[![CI](https://github.com/koad/hoppa/actions/workflows/ci.yml/badge.svg)](https://github.com/koad/hoppa/actions/workflows/ci.yml)

A one-tap jumping game, built as a **mobile-first PWA** that also runs as a
**Capacitor** native app. This folder exists to learn how to build, test and ship
Capacitor-based apps from a koad:io/Meteor codebase — and eventually to drive
Android and iOS builds from GitHub Actions.

**Live:** https://hoppa.koad.sh — open it on a phone and it will offer to install.

```
.
├── src/                       the Meteor app (this is what Capacitor will wrap)
│   ├── client/main.js         client entry — imports the rest, in order
│   ├── client/logic.js        game engine — canvas, physics, no dependencies
│   ├── client/scores.js       arcade initials entry + leaderboard rendering
│   ├── client/settings.js     gear menu: theme, tilt sensitivity, selfie face
│   ├── client/styles.css      mobile shell: full-bleed, no scroll/zoom, notch-safe
│   ├── client/templates.html  Blaze templates + PWA/Apple head tags
│   ├── server/main.js         server entry
│   ├── server/scores.js       validation, rate limiting, the two boards
│   ├── both/scores.js         the score collection + shared config
│   └── public/                manifest.webmanifest, sw.js, generated icons
├── tools/
│   ├── make-icons.mjs         regenerates the PWA icons as real PNGs (no image deps)
│   ├── cdp.mjs                dependency-free Chrome DevTools Protocol client
│   ├── smoke.mjs              does it run
│   ├── feel.mjs               does it PLAY right — asserts every mechanic below
│   ├── scores.mjs             does it PERSIST — drives the board end to end
│   └── settings.mjs           does it CONFIGURE — theme, sensitivity, real camera
└── capacitor.config.js        STAGED, not live — see the warning below
```

## The whole instruction set

**Avoid the squares. Collect the circles.**

Squares are hazards. Amber **blocks**, orange **tall** ones and pink **wide/low**
ones you jump. Violet **floaters** hang in the air — run *under* them; a full jump
will hit one. **Rainbow** platforms are the exception: come down on top for a big
bounce, run into the side and you are done.

| input | effect |
|---|---|
| tap | short hop (~85u) |
| tap and hold | higher, up to ~160u — longer hold, higher jump |
| tap again in the air | double jump (more after collecting +jump orbs) |
| tilt the device left / right | HOPPA slides — with the device LEVEL it sits dead centre |

### The circles

| orb | effect |
|---|---|
| green **+jump** | banks an extra air jump for the rest of the run, up to 6 |
| blue **slow** | slows the world scroll to 55% for 5s — more airtime, more points |
| gold **spring** | raises jump and bounce strength for 6s (a full-hold apex goes 160u → 225u) |

Effects show with their remaining time at the bottom of the screen, and spring
draws an aura on the player so an active effect is never invisible.

### Scoring

**Points come only from airtime, in proportion to height.** Landing stops the
clock. That re-frames the whole game — you want to be airborne, high, and for as
long as possible — and it is what makes the floaters interesting, because they
occupy exactly the air you want. Rainbow bounces pay a flat bonus on top.

## Settings — the gear

A pause menu: opening it stops the run, and no input reaches the game while it
is up.

| control | what it does |
|---|---|
| theme | midnight / sunset / forest / neon. Scenery and player only — the **hazard palette is deliberately fixed**, because "squares hurt, circles help" is the whole instruction set and a theme must never blur it. |
| tilt sensitivity | 0.4x – 3x. Higher reacts to a smaller tilt. |
| your face on the hoppa | opens the camera, centre-crops to a square, and draws the shot clipped into the hoppa |

All of it persists in localStorage and is re-applied on load.

## Orientation

The app detects portrait/landscape and adapts, rather than nagging you to rotate.
A landscape phone would otherwise leave a **~185-unit play area** — every jump
would exit the screen. So the engine keeps a height floor: when the viewport is
too short it makes the world *wider* instead of shorter, and `wScale` re-times
the scroll so a corridor still takes the same number of seconds to cross.
Difficulty is therefore orientation-independent, and both orientations are
properly playable (measured: `logicalH=320`, `viewW=693`, `wScale=1.731`).

## Leaderboard

Server-backed, in Mongo. Two boards: **all time** and **the last 72 hours**. When
a run qualifies, the arcade initials entry appears — three letter slots with
up/down arrows and an ENTER, or just type on a keyboard. Your letters are
remembered, so next time the slots are prefilled and you can hit ENTER.

**On trust:** scores are reported by the client, so anyone with a console can
fake one. The server clamps to sane bounds and rate-limits to 5 submissions per
minute per connection, which stops accidents and casual vandalism — not a
determined cheater. A trustworthy board would need the score derived from
server-replayable input rather than a number the browser hands over.

## Run it

```bash
cd src
meteor npm install
meteor run              # http://localhost:3000
```

## Test it

Four tools, four different questions. All dependency-free, all drive real headless
Chrome over CDP, all assert on the RUNTIME.

```bash
node tools/smoke.mjs    https://hoppa.koad.sh   # does it run
node tools/feel.mjs     https://hoppa.koad.sh   # does it play right
node tools/scores.mjs   https://hoppa.koad.sh   # does it persist
node tools/settings.mjs https://hoppa.koad.sh   # does it configure
```

- **smoke** — shell served, game mounted, a synthetic **touch** starts it,
  autopilot scores, phone viewport at DPR 2, no uncaught errors.
- **feel** — the actual jump arcs, measured rather than derived: a tap hops low, a
  hold goes high, two taps make two jumps, floaters are passable on a tap and
  fatal on a full jump, rainbows bounce on top and kill from the side, all six
  archetypes are reachable, each orb does what it claims, and tilt moves HOPPA.
- **scores** — drives the real initials buttons, submits over real DDP, and
  confirms the row count on the server went up. Also asserts the server *rejects*
  bad initials and absurd scores.
- **settings** — opens the gear, switches theme, moves the sensitivity slider,
  and takes a selfie through a **fake camera** (`--use-fake-device-for-media-stream`),
  so getUserMedia → centre-crop → JPEG → engine texture is exercised for real.
  Then it reloads and checks all of it persisted.

`feel.mjs` reads its numbers from the live page, so it cannot drift from the
engine. A feature that exists in the source but not in the physics is not a
feature, and these tools exist to catch exactly that.

Test hooks the engine exposes for the tools (harmless in normal play):
`?autostart=1`, `?autopilot=1`, `?sandbox=1` (no obstacles),
`?only=<archetype>`, and `window.HOPPA` for poking at a live run.

### Two implementation notes worth keeping

- **The tap IS the minimum jump** and holding *adds* height. The first version did
  the opposite and cut the jump on release, which meant a late or missed
  `pointerup` silently turned every tap into a full hold. Building the minimum in
  degrades gracefully: a missed release gives a bigger jump, never a broken one.
- **Tilt is optional by design.** iOS gates orientation behind a user-gesture
  permission prompt, asked on the tap that starts the game. Denied, unsupported,
  or desktop: tilt stays at zero and the game is fully playable. Arrow keys work
  as a fallback. If left/right feels backwards, `window.HOPPA.invertTilt()` flips it.

## ⚠️ Why `capacitor.config.js` is not in `src/`

Meteor loads **root-level `.js` files as application code** — on the server.
`capacitor.config.js` therefore *executes at boot* and `require`s
`@meteorjs/capacitor`. On an app that has not run `meteor add capacitor`, that is
a hard crash:

```
Error: Cannot find module '.../programs/server/node_modules/@meteorjs/capacitor'
```

So the config is staged here at the repo root and only moves into `src/` once the
Capacitor package is actually added:

```bash
meteor add capacitor
cp capacitor.config.js src/          # commit it BEFORE the first native command,
                                     # or Meteor scaffolds one from the directory
                                     # name and you ship `com.example.src`
```

## Native builds (Capacitor): WAIT

Read **[CAPACITOR.md](CAPACITOR.md)** before attempting anything native.

Short version: Capacitor is not in any Meteor release. It exists only on an
unmerged draft branch, so producing an APK today would mean building the Meteor
tool from that branch and accepting a downgrade of 17 core packages. That file
holds the resume trigger, the full evidence, the playbook for when it ships, and
the traps already paid for.

## Status

| | state |
|---|---|
| the game | ✅ done, live at https://hoppa.koad.sh |
| four test suites | ✅ 71 checks |
| CI on every push | ✅ green in ~1m40s, free runner |
| **native build (APK/iOS)** | ⛔ **blocked upstream — see [CAPACITOR.md](CAPACITOR.md)** |

The web side is finished. The native side cannot start: the Capacitor
integration is unmerged upstream, so there is nothing to build against.

## Stack — published packages only

The app runs on released Meteor with nothing but published Atmosphere packages
and four npm dependencies. No `METEOR_PACKAGE_DIRS`, no vendored packages,
nothing that exists on only one machine — which is what makes CI possible.

```
meteor-base  mongo  blaze-html-templates  jquery  tracker  ecmascript
standard-minifier-css  standard-minifier-js  shell-server  es5-shim
typescript  mobile-experience  reactive-var
rspack  hot-module-replacement  blaze-hot
```

`package.json` declares the modern entry points (`meteor.mainModule.client` and
`.server`) with `meteor.modern: true`, so the client is bundled by Rspack. Two
consequences worth knowing:

- With `mainModule` set, **only files reachable from an entry are loaded.** The
  classic "everything under `client/` is auto-loaded" convention no longer
  applies; `client/main.js` and `server/main.js` import the rest, in order.
- This layout is not optional here. The earlier build appeared to work without
  it because a private framework package pulled the bundler in transitively.
  Standing on published packages alone requires the modern layout — the classic
  loader serves loose package scripts in an order that leaves Blaze without
  jQuery (`Uncaught Error: jQuery not found` at `blaze.js`).
