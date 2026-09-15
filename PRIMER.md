# Project Primer

HOPPA — a mobile-first PWA jumping game, and the rig used to learn Capacitor.

## Layout

```
src/                      the Meteor app
  client/main.js          client entry — imports the rest, in order
  client/logic.js         game engine (canvas, physics, zero dependencies)
  client/scores.js        arcade initials + leaderboard
  client/settings.js      gear menu: theme, tilt, selfie
  client/styles.css       mobile shell
  client/templates.html   Blaze templates + head tags
  server/main.js          server entry
  server/scores.js        validation, rate limiting, the two boards
  both/scores.js          collection + shared config
  public/                 manifest, service worker, generated icons
tools/                    dependency-free helpers
  cdp.mjs                 minimal Chrome DevTools Protocol client
  smoke.mjs               does it run
  feel.mjs                does it play right
  scores.mjs              does it persist
  settings.mjs            does it configure
  make-icons.mjs          regenerates the PWA icons from source
```

## Conventions

- **Game code is client-side and dependency-free.** The engine owns the canvas
  and writes the DOM nodes it needs; the only server surface is the leaderboard.
- **Only files reachable from an entry are loaded.** `client/main.js` and
  `server/main.js` import everything else, and their import order is meaningful.
  See the stack section of README.md.
- **Tests assert runtime state over real CDP**, never HTTP status. A canvas game
  has no endpoint to curl, and a Meteor server happily answers 200 while its
  bundle is crashed.
- Everything configurable is persistent and testable: theme, tilt sensitivity and
  the player's face all survive a reload and are covered by `settings.mjs`.

See README.md for controls, scoring, the leaderboard, and how to run it.
