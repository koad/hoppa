# HOPPA — the koad:io mobile rig

A one-tap jumping game, built as a **mobile-first PWA** that also runs as a
**Capacitor** native app. This folder exists to learn how to build, test and ship
Capacitor-based apps from a koad:io/Meteor codebase — and eventually to drive
Android and iOS builds from GitHub Actions.

**Play it:** `cd src && meteor run` → open the printed URL on your phone.

```
.
├── src/                     the Meteor app (this is the app Capacitor will wrap)
│   ├── client/logic.js      game engine — canvas, physics, no dependencies
│   ├── client/styles.css    mobile shell: full-bleed, no scroll/zoom, notch-safe
│   ├── client/templates.html  Blaze mount + PWA/Apple head tags
│   └── public/              manifest.webmanifest, sw.js, generated icons
├── tools/
│   ├── make-icons.mjs       regenerates the PWA icons as real PNGs (no image deps)
│   ├── cdp.mjs              dependency-free Chrome DevTools Protocol client
│   └── smoke.mjs            headless smoke test — the CI template
└── capacitor.config.js      STAGED, not live — see the warning below
```

## Run it

```bash
cd src
meteor npm install
meteor run              # http://localhost:3000
```

## Test it

```bash
node tools/smoke.mjs                       # against localhost:3000
node tools/smoke.mjs http://localhost:20540 --seconds=10
```

Asserts, in a real headless Chrome over CDP: the shell served, the game mounted,
it starts in `ready`, **a synthetic touch starts the game**, autopilot
accumulates a score (proving rAF + physics + spawning + collision), the phone
viewport and DPR applied, and zero uncaught errors.

A canvas game has no endpoint to curl, so this is the only honest way to assert
it — and it is the seam that grows into the native pipeline.

Two flags exist purely to make the game assertable and are **not** dev cruft:

| flag | effect |
|---|---|
| `?autostart=1` | skip the ready screen, play immediately |
| `?autopilot=1` | implies autostart; jumps for itself |

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
# once the Capacitor tooling is in place (see below):
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
2. `meteor add-platform android` → Gradle project at the app root
3. real APK: needs `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64` + Gradle 8.11.1
4. lift `tools/smoke.mjs` into GitHub Actions, then extend to iOS

## App-owned npm dependencies

`koad:io-core`, `koad:io` and `koad:io-router` `require()` npm modules they do not
declare in `Npm.depends()`; by convention the **app** supplies them. Without them
the app cannot boot. They are pinned here to match the live reference app:

`signale@1.4.0` · `ssh2@1.14.0` · `systeminformation@5.11.14` · `node-machine-id@1.1.12`
`path-to-regexp@6.2.1` · `useragent@2.3.0` · `ua-parser-js@1.0.35` · `geoip-lite@1.2.1`
`body-parser@1.12.4` · `web-vitals@3.0.4`
