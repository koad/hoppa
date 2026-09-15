# HOPPA — the koad:io mobile rig

A one-tap jumping game, built as a **mobile-first PWA** that also runs as a
**Capacitor** native app. This folder exists to learn how to build, test and ship
Capacitor-based apps from a koad:io/Meteor codebase — and eventually to drive
Android and iOS builds from GitHub Actions.

**Live:** https://hoppa.koad.sh — open it on a phone and it will offer to install.

```
.
├── src/                       the Meteor app (this is what Capacitor will wrap)
│   ├── both/scores.js         the score collection + shared config
│   ├── server/scores.js       validation, rate limiting, the two boards
│   ├── client/logic.js        game engine — canvas, physics, no dependencies
│   ├── client/scores.js       arcade initials entry + leaderboard rendering
│   ├── client/styles.css      mobile shell: full-bleed, no scroll/zoom, notch-safe
│   ├── client/templates.html  Blaze mount + PWA/Apple head tags
│   └── public/                manifest.webmanifest, sw.js, generated icons
├── tools/
│   ├── make-icons.mjs         regenerates the PWA icons as real PNGs (no image deps)
│   ├── cdp.mjs                dependency-free Chrome DevTools Protocol client
│   ├── smoke.mjs              does it run
│   ├── feel.mjs               does it PLAY right — asserts every mechanic below
│   └── scores.mjs             does it PERSIST — drives the board end to end
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
| tilt the device left / right | HOPPA slides left / right for control |

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

Three tools, three different questions. All dependency-free, all drive real
headless Chrome over CDP.

```bash
node tools/smoke.mjs  https://hoppa.koad.sh    # does it run
node tools/feel.mjs   https://hoppa.koad.sh    # does it play right
node tools/scores.mjs https://hoppa.koad.sh    # does it persist
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

## The two tracks (they cannot be combined yet)

| | Meteor 3.6-beta.0 | Capacitor |
|---|---|---|
| available | ✅ published 2026-09-10 | ⚠️ checkout branch only |
| contains the other | ❌ | ❌ |
| cost | clean upgrade | **downgrades 17 core packages** vs 3.5.2 |

Capacitor is not in any release. It lives on `meteor/meteor` branch
`capacitor-integration` (PR #14633, still draft), so native builds require
building the tool from that checkout. Full writeup:
`~/.vulcan/assessments/2026-09-14-meteor-36-beta-mobile-rig.md`

## Next

1. add Capacitor (`meteor add capacitor` from the checkout tool), move the config in
2. `meteor add platform android` → Gradle project at the app root
3. real APK: needs `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64` + Gradle 8.11.1
4. lift the three tools into GitHub Actions, then extend to iOS

## App-owned npm dependencies

`koad:io-core`, `koad:io` and `koad:io-router` `require()` npm modules they do not
declare in `Npm.depends()`; by convention the **app** supplies them. Without them
the app cannot boot at all. Pinned to match the live reference app:

`signale@1.4.0` · `ssh2@1.14.0` · `systeminformation@5.11.14` · `node-machine-id@1.1.12`
`path-to-regexp@6.2.1` · `useragent@2.3.0` · `ua-parser-js@1.0.35` · `geoip-lite@1.2.1`
`body-parser@1.12.4` · `web-vitals@3.0.4`
