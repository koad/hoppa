# Capacitor: WAIT

**Verdict as of 2026-09-15: do not build on this. Waiting on upstream.**

The point of this folder was to test **Meteor + Capacitor** and get a real mobile
build (APK). That is not possible today, and it was not possible yesterday
either. This file exists so the next visit starts from the findings instead of
re-learning them.

---

## The one-line answer to "should we wait?"

**Yes.** To produce an APK today you would have to clone `meteor/meteor` at a
**draft pull-request branch**, build the Meteor tool from it, accept a
**downgrade of 17 core packages** versus the current release, install JDK 21 +
Android SDK + Gradle 8.11.1, and then run Gradle yourself. That is a large amount
of work built on something that can change under you without notice — not a test
of Meteor + Capacitor, a test of one unmerged branch.

## Resume trigger — check this first, then come back

```bash
# 1. Is the package on a released Meteor?
meteor show capacitor
#    "not found"          -> still waiting
#    "capacitor@x.y.z"    -> GO

# 2. Or is it in devel / a release branch?
gh api repos/meteor/meteor/contents/packages/capacitor --jq .name
gh api repos/meteor/meteor/pulls/14633 --jq '"\(.state) draft=\(.draft) merged=\(.merged)"'
#    merged=true          -> GO
```

## The evidence (all re-checked 2026-09-15)

| Question | Answer |
|---|---|
| PR `meteor/meteor#14633` | **open, draft, not merged** — 72 commits |
| `capacitor-integration` branch | last commit **2026-07-31** (6+ weeks stale) |
| `packages/capacitor` on `devel` | **404 — absent** |
| `packages/capacitor` on `release-3.6` | **404 — absent** |
| Latest released Meteor | **3.5.2** |
| So is Capacitor in Meteor 3.6? | **No.** 3.6-beta.0 shipped 2026-09-10 without it. |
| `@meteorjs/capacitor` on npm | `0.2.0-alpha.1` (2026-06-24) — the npm half exists, the Meteor package half does not |
| Maintainer's own timeline | experimental beta *possibly* in 3.6, official in **3.7** — "a possibility, not a commitment" |

**Therefore:** "upgrade to 3.6 and play with Capacitor" was never a thing that
existed. Those are two separate tracks and 3.6 does not contain Capacitor.

---

## What to do when the trigger fires

```bash
cd src
meteor add capacitor                                  # from a RELEASED meteor
cp ../capacitor.config.js .                           # staged at the repo root — see traps below
meteor add-platform android
meteor run android --mobile-server http://10.0.2.2:3000
```

**An APK is NOT produced by `meteor build`.** It prepares and syncs the native
project; the artifact comes from Gradle or the Capacitor CLI:

```bash
meteor build ../out --directory --server=https://your.host --platforms=android
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./android/gradlew -p android assembleDebug
#   -> android/app/build/outputs/apk/debug/app-debug.apk
#   -> or: npx cap build android     /     bundleRelease for a Play AAB
```

For CI: Android on `ubuntu-latest` is plausible (free for public repos). iOS
needs a macOS runner (also free for public repos, but queues longer).

---

## Traps already paid for — do not pay twice

1. **`capacitor.config.js` at the app root is EXECUTED as application code.**
   Meteor loads root-level `.js` files, so it runs at boot and `require`s
   `@meteorjs/capacitor`. On an app without the package that is a hard crash:
   `Cannot find module .../node_modules/@meteorjs/capacitor`. It is staged at this
   repo root for that reason. Also: if it is missing when you run the first native
   command, Meteor scaffolds one from the **directory name** and you ship
   `com.example.src`.
2. **`meteor build` prepares, it does not package.** No APK/AAB/IPA. See above.
3. **Under Capacitor the bundle target is still `web.cordova`, so
   `Meteor.isCordova` is `true`.** Use `Meteor.isCapacitor` for new checks.
4. **`@meteorjs/capacitor@0.2.0-alpha.1` imports `@capacitor/splash-screen` and
   `@ionic/pwa-elements` without declaring either.** Every build warns
   "Unable to resolve some modules"; install them explicitly.
5. **The docs say JDK 17. Capacitor 7 needs JDK 21.** `pre-installation.md` in the
   PR is wrong on this.
6. **The branch downgrades a current app.** On a 3.5.2 app it pulled
   `ecmascript 0.19.1→0.18.0`, `mongo 2.5.1→2.3.0`, `webapp 2.3.0→2.1.2`,
   `tools-core 1.3.0→1.1.0` and upgraded `jquery 1.11.11→3.0.2` flagged
   not-backwards-compatible. Adopting Capacitor was **not additive**.
7. **`BIND_IP` is dead in Meteor 3.5.2's tool** — dev mode always binds `0.0.0.0`.

## What IS already built and reusable

- **The app** (`src/`) — a mobile-first PWA game with a leaderboard. Verified
  working, and portable.
- **Four test suites** (`tools/`) — `smoke` / `feel` / `scores` / `settings`,
  71 checks, dependency-free, driving real headless Chrome over a hand-rolled CDP
  client. `feel.mjs` measures the actual physics rather than trusting constants.
- **CI** (`.github/workflows/ci.yml`) — green in ~1m40s on a free runner. It
  asserts the app builds from **published packages only** (no
  `METEOR_PACKAGE_DIRS`), which is what makes a runner possible at all.
- **A verified 3.6 rig**: `Meteor 3.6-beta.0` upgrades, compiles under Rspack 2
  and boots — modern client bundle 33% smaller than legacy. Untouched by Capacitor.
- **A verified Capacitor rig**: `add capacitor` → `add-platform android` →
  `build --platforms=android` all worked on the branch, producing `_build/native-*`
  and a synced Gradle project at the app root. The pipeline is real; it is just
  unreleased.

## On disk (deletable, ~4GB total)

| path | what |
|---|---|
| `~/Workbench/meteor-checkout` | 1.6G — the draft branch, built |
| `~/Workbench/capacitor-rig` | 1.3G — the app with Capacitor added + Gradle project |
| `~/Workbench/meteor-36-beta` | 742M — the verified 3.6-beta.0 rig |
| `~/Workbench/bare-verify` | 463M — a scratch spawn |

## What CI covers, and what it does not

Covers: the app boots, plays, persists scores, configures — on every push.
Does **not** cover: anything native. There is nothing to cover until Capacitor is
released.

---

*Written 2026-09-15, after a day spent on this. If you are reading it much later,
re-run the resume trigger first — the whole file may be obsolete.*
