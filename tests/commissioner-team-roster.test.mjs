import assert from 'node:assert/strict';
import test from 'node:test';
import { updateCommissionerTeamRoster } from '../commissioner-team-roster.js';

const pikachu = { id: 33, name: 'Pikachu', variation: '', tier: 1 };

function makeDraft() {
  return {
    draftedIds: {},
    trainers: [
      { uid: 'a', name: 'Team A', budget: 80, roster: [] },
      { uid: 'b', name: 'Team B', budget: 75, roster: [] }
    ]
  };
}

test('commissioner can add a Pokémon to a team without changing its budget', () => {
  const draft = makeDraft();
  const updated = updateCommissionerTeamRoster(draft, 'a', 'add', pikachu);

  assert.deepEqual(updated.trainers[0].roster, [pikachu]);
  assert.equal(updated.trainers[0].budget, 80);
  assert.deepEqual(updated.draftedIds['33'], { trainerIdx: 0, tier: 1 });
  assert.deepEqual(draft.trainers[0].roster, []);
});

test('commissioner can remove a team Pokémon and release its drafted ID', () => {
  const draft = makeDraft();
  draft.trainers[0].roster = [pikachu];
  draft.draftedIds['33'] = { trainerIdx: 0, tier: 1 };

  const updated = updateCommissionerTeamRoster(draft, 'a', 'remove', pikachu);

  assert.deepEqual(updated.trainers[0].roster, []);
  assert.equal(updated.draftedIds['33'], undefined);
  assert.equal(draft.trainers[0].roster.length, 1);
});

test('commissioner cannot assign one Pokémon to multiple teams', () => {
  const draft = makeDraft();
  draft.trainers[1].roster = [pikachu];
  draft.draftedIds['33'] = { trainerIdx: 1, tier: 1 };

  assert.throws(
    () => updateCommissionerTeamRoster(draft, 'a', 'add', pikachu),
    /already assigned/
  );
});
