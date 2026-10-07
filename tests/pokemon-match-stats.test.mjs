import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePokemonMvpRace } from '../pokemon-match-stats.js';

test('MVP race counts regular-season and playoff appearances and applies the requested tie-breakers', () => {
  const league = {
    draft: {
      history: [{ monId: 1 }, { monId: 2 }, { monId: 3 }],
      trainers: [
        { uid: 'a', name: 'Team A', roster: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Bravo' }] },
        { uid: 'b', name: 'Team B', roster: [{ id: 3, name: 'Charlie' }] }
      ]
    },
    schedule: {
      weeks: [{ matches: [{ a: 'a', b: 'b' }] }],
      results: {
        '0_0': {
          locked: true,
          games: [
            { pokemonStats: {
              a: [{ pokemonId: 1, kills: 2, deaths: 0 }, { pokemonId: 2, kills: 1, deaths: 0 }],
              b: [{ pokemonId: 3, kills: 1, deaths: 0 }]
            } },
            { pokemonStats: {
              a: [{ pokemonId: 1, kills: 1, deaths: 1 }, { pokemonId: 2, kills: 0, deaths: 0 }],
              b: [{ pokemonId: 3, kills: 1, deaths: 0 }]
            } }
          ]
        }
      }
    },
    playoffBracket: {
      rounds: [{ matches: [{ a: 'a', b: 'b', locked: true, games: [{
        pokemonStats: {
          a: [{ pokemonId: 2, kills: 1, deaths: 0 }],
          b: [{ pokemonId: 3, kills: 0, deaths: 1 }]
        }
      }] }] }]
    },
    transactionLog: [{ type: 'fa_swap', trainerUid: 'a', drops: [{ id: 4, name: 'Dropped Mon' }], claims: [] }]
  };
  const race = calculatePokemonMvpRace(league);
  assert.deepEqual(race.slice(0, 3).map(row => [row.id, row.kills, row.deaths, row.gamesPlayed]), [
    [1, 3, 1, 2],
    [2, 2, 0, 3],
    [3, 2, 1, 3]
  ]);
  assert.ok(race.some(row => row.name === 'Dropped Mon' && row.gamesPlayed === 0));
  assert.ok(race.some(row => row.id === 3 && row.trainerName === 'Team B'));
});
