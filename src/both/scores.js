/**
 * HOPPA scores — shared between client and server.
 *
 * NOTE ON TRUST: scores are reported by the client, so they are spoofable by
 * anyone with a console. The server clamps them to sane bounds and rate-limits
 * submissions, which stops accidents and casual vandalism, but this is a toy
 * leaderboard, not a ranking system. If it ever needs to be trustworthy the
 * score would have to be derived from server-replayable input, not a number the
 * browser hands over.
 *
 * `globalThis` assignment is deliberate: Meteor loads each app file as its own
 * module, so a `const` here would be invisible to the other files.
 */

globalThis.HoppaScores = new Mongo.Collection('hoppaScores');

globalThis.HoppaScoreConfig = {
  INITIALS: 3,
  LETTERS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  BOARD: 5,                 // rows shown per column
  WINDOW_HOURS: 72,         // the "recent" board
  MAX_SCORE: 200000,        // sanity ceiling, not a real limit
  MAX_BOUNCES: 10000,
  MAX_SUBMITS_PER_MIN: 5
};
