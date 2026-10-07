import assert from 'node:assert/strict';
import test from 'node:test';
import { advancePlayoffWinner, createPlayoffBracket } from '../playoff-bracket.js';

function rows(count) {
  return Array.from({ length: count }, (_, index) => ({ uid: 'seed-' + (index + 1) }));
}

function resolveRound(bracket, winnersByMatch) {
  const round = bracket.rounds[0];
  round.matches.forEach((match, matchIdx) => {
    if (match.locked) return;
    match.winner = winnersByMatch[matchIdx];
    match.winnerSeed = bracket.seeds[match.winner];
    match.locked = true;
    advancePlayoffWinner(bracket, 0, matchIdx);
  });
}

test('five-team odd bracket reseeds the top seed against the lowest advancing seed', () => {
  const bracket = createPlayoffBracket(rows(5), 5);
  assert.equal(bracket.oddQualifiers, true);
  assert.equal(bracket.rounds[1].matches[0].a, null);

  resolveRound(bracket, { 1: 'seed-5' });
  assert.deepEqual(
    bracket.rounds[1].matches.map(match => [match.a, match.b]),
    [['seed-1', 'seed-5'], ['seed-2', 'seed-3']]
  );
});

test('seven-team odd bracket reseeds across all first-round winners', () => {
  const bracket = createPlayoffBracket(rows(7), 7);
  resolveRound(bracket, { 1: 'seed-5', 2: 'seed-7', 3: 'seed-6' });
  assert.deepEqual(
    bracket.rounds[1].matches.map(match => [match.a, match.b]),
    [['seed-1', 'seed-7'], ['seed-5', 'seed-6']]
  );
});

test('nine-team bracket carries first-round byes into a seed-reseeded quarterfinal', () => {
  const bracket = createPlayoffBracket(rows(9), 9);
  resolveRound(bracket, { 1: 'seed-9' });
  assert.deepEqual(
    bracket.rounds[1].matches.map(match => [match.a, match.b]),
    [['seed-1', 'seed-9'], ['seed-2', 'seed-7'], ['seed-3', 'seed-6'], ['seed-4', 'seed-5']]
  );
});

test('correcting an odd first-round result resets later rounds when reseeding changes opponents', () => {
  const bracket = createPlayoffBracket(rows(7), 7);
  resolveRound(bracket, { 1: 'seed-5', 2: 'seed-7', 3: 'seed-6' });
  bracket.rounds[1].matches[0].winner = 'seed-1';
  bracket.rounds[1].matches[0].locked = true;
  bracket.rounds[1].matches[0].games = [{ a: 3, b: 0 }];
  bracket.rounds[2].matches[0].a = 'seed-1';
  bracket.rounds[2].matches[0].locked = true;
  bracket.rounds[2].matches[0].winner = 'seed-1';

  const correctedMatch = bracket.rounds[0].matches[3];
  correctedMatch.winner = 'seed-3';
  correctedMatch.winnerSeed = 3;
  assert.equal(advancePlayoffWinner(bracket, 0, 3), true);
  assert.equal(bracket.rounds[1].matches[0].winner, null);
  assert.equal(bracket.rounds[1].matches[0].games.length, 0);
  assert.equal(bracket.rounds[1].matches[1].b, 'seed-5');
  assert.equal(bracket.rounds[2].matches[0].a, null);
  assert.equal(bracket.rounds[2].matches[0].locked, false);
});

test('three-team bracket advances the top seed directly to the final', () => {
  const bracket = createPlayoffBracket(rows(3), 3);
  resolveRound(bracket, { 1: 'seed-3' });
  assert.deepEqual(
    bracket.rounds[1].matches.map(match => [match.a, match.b]),
    [['seed-1', 'seed-3']]
  );
});

test('even-team brackets retain their original matchups and do not advance through unknown slots', () => {
  const bracket = createPlayoffBracket(rows(6), 6);
  assert.equal(bracket.oddQualifiers, false);
  assert.equal(bracket.rounds[1].matches[0].a, 'seed-1');
  assert.equal(bracket.rounds[1].matches[0].winner, null);
  assert.equal(bracket.rounds[1].matches[1].a, 'seed-2');
  assert.equal(bracket.rounds[1].matches[1].winner, null);
});
