'use strict';

/**
 * SCORING CONFIG — edit this to change the game.
 * Each tier: if percent error is <= maxPctError (inclusive), award `points`.
 * Tiers are checked from tightest to loosest. Anything outside every tier gets `missPoints`.
 * maxPctError is a fraction: 0.05 = 5%.
 */
const SCORING = {
  tiers: [
    { maxPctError: 0.05, points: 5 },
    { maxPctError: 0.10, points: 4 },
    { maxPctError: 0.20, points: 3 },
    { maxPctError: 0.25, points: 2 },
    { maxPctError: 0.30, points: 1 },
  ],
  missPoints: 0,
  // Tie-breaker: a player who didn't guess an item is charged this % error for it,
  // and no single item can add more than this to cumulative error.
  maxErrorPerItem: 1.0,
};

// Tolerance so values like exactly 5.000% are never lost to floating point.
const EPS = 1e-9;

const toCents = (n) => Math.round(Number(n) * 100);

/** |guess - price| / price, computed in whole cents to keep boundaries exact. */
function percentError(guess, price) {
  const p = toCents(price);
  if (!(p > 0)) throw new Error('True price must be greater than 0');
  const g = toCents(guess);
  if (!Number.isFinite(g) || g < 0) throw new Error('Guess must be a non-negative number');
  return Math.abs(g - p) / p;
}

function pointsForError(pctError, config = SCORING) {
  const tiers = [...config.tiers].sort((a, b) => a.maxPctError - b.maxPctError);
  for (const t of tiers) {
    if (pctError <= t.maxPctError + EPS) return t.points;
  }
  return config.missPoints;
}

function scoreGuess(guess, price, config = SCORING) {
  const pctError = percentError(guess, price);
  return { pctError, points: pointsForError(pctError, config) };
}

module.exports = { SCORING, EPS, percentError, pointsForError, scoreGuess };
