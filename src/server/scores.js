/**
 * HOPPA scores — server.
 *
 * Two methods, no publications: the board only changes when somebody submits,
 * so a pull on demand is simpler than a live subscription and has none of the
 * publication-lifecycle edge cases. If a crowd ever shows up, swap
 * `hoppa.leaderboard` for a publication and let Blaze do the diffing.
 *
 * NOTE: scores are reported by the client and are therefore spoofable by anyone
 * with a console. The validation below stops accidents and casual vandalism, not
 * a determined cheater. A trustworthy board would need the score derived from
 * server-replayable input rather than a number the browser hands over.
 */

const CFG = globalThis.HoppaScoreConfig;
const WINDOW_MS = CFG.WINDOW_HOURS * 3600 * 1000;
const FIELDS = { initials: 1, score: 1, bounces: 1, createdAt: 1 };

// connectionId -> [timestamps]
const submitLog = new Map();

/** Character check rather than a built regex literal. Concatenating
 *  '^[A-Z]{n}$' has bitten this file once already. */
function isInitials(s) {
  if (typeof s !== 'string' || s.length !== CFG.INITIALS) return false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] < 'A' || s[i] > 'Z') return false;
  }
  return true;
}

Meteor.startup(async () => {
  try {
    await HoppaScores.createIndexAsync({ score: -1 });
    await HoppaScores.createIndexAsync({ createdAt: -1 });
  } catch (err) {
    // indexes are an optimisation; a failure here must never stop the app
    console.warn('[hoppa] index creation skipped:', err && err.message);
  }
});

function boardQuery(filter) {
  return HoppaScores.find(filter, {
    sort: { score: -1, createdAt: 1 },
    limit: CFG.BOARD,
    fields: FIELDS
  });
}

/** Read both boards. A plain function so submitScore can return the fresh state
 *  directly instead of re-entering the method layer. */
async function readBoard() {
  const since = new Date(Date.now() - WINDOW_MS);
  const [allTime, recent, total] = await Promise.all([
    boardQuery({}).fetchAsync(),
    boardQuery({ createdAt: { $gte: since } }).fetchAsync(),
    HoppaScores.find({}).countAsync()
  ]);
  return { allTime, recent, windowHours: CFG.WINDOW_HOURS, total, generatedAt: Date.now() };
}

Meteor.methods({
  async 'hoppa.leaderboard'() {
    return readBoard();
  },

  async 'hoppa.submitScore'(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Meteor.Error('bad-request', 'expected a score payload');
    }

    // rate limit per connection: three letters is cheap, spam is not
    const connId = (this.connection && this.connection.id) || 'unknown';
    const now = Date.now();
    const recentSubmits = (submitLog.get(connId) || []).filter((t) => now - t < 60_000);
    if (recentSubmits.length >= CFG.MAX_SUBMITS_PER_MIN) {
      throw new Meteor.Error('rate-limited', 'too many scores submitted; slow down');
    }
    recentSubmits.push(now);
    submitLog.set(connId, recentSubmits);

    // STRICT, not lenient: truncating a long string to three letters would
    // silently stamp somebody else's initials onto the board.
    const initials = String(payload.initials || '').toUpperCase();
    if (!isInitials(initials)) {
      throw new Meteor.Error('bad-initials', 'initials must be exactly ' + CFG.INITIALS + ' letters A-Z');
    }

    const score = Math.floor(Number(payload.score));
    if (!Number.isFinite(score) || score < 0 || score > CFG.MAX_SCORE) {
      throw new Meteor.Error('bad-score', 'score out of range');
    }

    const bounces = Math.min(
      CFG.MAX_BOUNCES,
      Math.max(0, Math.floor(Number(payload.bounces) || 0))
    );

    const _id = await HoppaScores.insertAsync({
      initials, score, bounces, createdAt: new Date()
    });

    const board = await readBoard();
    return { ok: true, _id, board };
  }
});
