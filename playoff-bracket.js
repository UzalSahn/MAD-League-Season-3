export const SEED_ORDER = {
  2: [1, 2],
  4: [1, 4, 2, 3],
  8: [1, 8, 4, 5, 2, 7, 3, 6],
  16: [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]
};

export function createPlayoffBracket(rows, playoffTeams) {
  if (rows.length < playoffTeams) throw new Error('Not enough trainers for this playoff bracket.');
  if (!Number.isInteger(playoffTeams) || playoffTeams < 2 || playoffTeams > 16) {
    throw new Error('Playoff brackets must contain between 2 and 16 teams.');
  }

  let bracketSize = 2;
  while (bracketSize < playoffTeams) bracketSize *= 2;
  const order = SEED_ORDER[bracketSize];
  if (!order) throw new Error('Could not create a bracket for this number of teams.');

  const seedByUid = {};
  const seededUids = order.map(seed => {
    if (seed > playoffTeams) return null;
    const uid = rows[seed - 1].uid;
    seedByUid[uid] = seed;
    return uid;
  });
  const rounds = [];
  const firstRoundMatches = [];
  for (let i = 0; i < seededUids.length; i += 2) {
    const a = seededUids[i], b = seededUids[i + 1];
    const match = {
      a, b, winner: null, winnerSeed: null,
      seedA: a ? seedByUid[a] : null,
      seedB: b ? seedByUid[b] : null,
      games: [], locked: false
    };
    if (a && !b) {
      match.winner = a;
      match.winnerSeed = match.seedA;
      match.locked = true;
    } else if (b && !a) {
      match.winner = b;
      match.winnerSeed = match.seedB;
      match.locked = true;
    }
    firstRoundMatches.push(match);
  }
  rounds.push({ label: 'Round 1', matches: firstRoundMatches });

  let remaining = firstRoundMatches.length / 2;
  const laterLabels = remaining >= 4 ? ['Quarterfinals', 'Semifinals', 'Final']
    : remaining === 2 ? ['Semifinals', 'Final'] : ['Final'];
  let labelIdx = 0;
  while (remaining >= 1) {
    const matches = [];
    for (let i = 0; i < remaining; i++) {
      matches.push({ a: null, b: null, winner: null, winnerSeed: null, seedA: null, seedB: null, games: [], locked: false });
    }
    rounds.push({ label: laterLabels[labelIdx], matches });
    labelIdx++;
    if (remaining === 1) break;
    remaining /= 2;
  }

  if (playoffTeams % 2 === 0) {
    firstRoundMatches.forEach((match, matchIdx) => {
      if (!match.locked || !rounds[1]) return;
      const nextMatch = rounds[1].matches[Math.floor(matchIdx / 2)];
      if (!nextMatch) return;
      const side = matchIdx % 2 === 0 ? 'a' : 'b';
      nextMatch[side] = match.winner;
      nextMatch[side === 'a' ? 'seedA' : 'seedB'] = match.winnerSeed;
    });
  }

  return {
    generatedAt: Date.now(),
    oddQualifiers: playoffTeams % 2 === 1,
    seeds: seedByUid,
    rounds
  };
}

export function advancePlayoffWinner(bracket, roundIdx, matchIdx) {
  const round = bracket.rounds[roundIdx];
  const match = round && round.matches[matchIdx];
  if (!match || !match.winner || !bracket.rounds[roundIdx + 1]) return;

  if (bracket.oddQualifiers && roundIdx === 0) {
    if (!round.matches.every(roundMatch => roundMatch.locked)) return;
    const advancing = round.matches
      .filter(roundMatch => roundMatch.winner)
      .map(roundMatch => ({ uid: roundMatch.winner, seed: bracket.seeds[roundMatch.winner] }))
      .sort((a, b) => a.seed - b.seed);
    const nextRound = bracket.rounds[1];
    let pairingsChanged = false;
    nextRound.matches.forEach((nextMatch, nextMatchIdx) => {
      const a = advancing[nextMatchIdx];
      const b = advancing[advancing.length - 1 - nextMatchIdx];
      if (nextMatch.a !== a.uid || nextMatch.b !== b.uid) pairingsChanged = true;
    });
    if (pairingsChanged) {
      bracket.rounds.slice(1).forEach((laterRound, laterRoundIdx) => {
        laterRound.matches.forEach(nextMatch => {
          nextMatch.winner = null;
          nextMatch.winnerSeed = null;
          nextMatch.games = [];
          nextMatch.locked = false;
          nextMatch.forfeit = false;
          nextMatch.mvp = null;
          if (laterRoundIdx > 0) {
            nextMatch.a = null;
            nextMatch.b = null;
            nextMatch.seedA = null;
            nextMatch.seedB = null;
          }
        });
      });
    }
    nextRound.matches.forEach((nextMatch, nextMatchIdx) => {
      const a = advancing[nextMatchIdx];
      const b = advancing[advancing.length - 1 - nextMatchIdx];
      nextMatch.a = a.uid;
      nextMatch.seedA = a.seed;
      nextMatch.b = b.uid;
      nextMatch.seedB = b.seed;
      if (pairingsChanged) {
        nextMatch.winner = null;
        nextMatch.winnerSeed = null;
        nextMatch.games = [];
        nextMatch.locked = false;
        nextMatch.forfeit = false;
        nextMatch.mvp = null;
      }
    });
    return pairingsChanged;
  }

  const nextMatch = bracket.rounds[roundIdx + 1].matches[Math.floor(matchIdx / 2)];
  if (!nextMatch) return false;
  const side = matchIdx % 2 === 0 ? 'a' : 'b';
  nextMatch[side] = match.winner;
  nextMatch[side === 'a' ? 'seedA' : 'seedB'] = bracket.seeds && bracket.seeds[match.winner] || null;
  return false;
}
