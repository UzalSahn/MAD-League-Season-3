export function updateCommissionerTeamRoster(draft, trainerUid, action, pokemon) {
  if (!draft || !Array.isArray(draft.trainers) || !pokemon || pokemon.id == null) {
    throw new Error('The team roster data is incomplete.');
  }
  if (action !== 'add' && action !== 'remove') {
    throw new Error('Choose whether to add or remove a Pokémon.');
  }

  const trainerIndex = draft.trainers.findIndex(trainer => trainer.uid === trainerUid);
  if (trainerIndex === -1) throw new Error('That team could not be found.');
  const trainer = draft.trainers[trainerIndex];
  const roster = trainer.roster || [];
  const pokemonId = String(pokemon.id);
  const owner = draft.trainers.find(team => (team.roster || []).some(mon => String(mon.id) === pokemonId));

  if (action === 'add') {
    if (owner || (draft.draftedIds || {})[pokemonId]) {
      throw new Error('That Pokémon is already assigned to a team.');
    }
  } else if (!roster.some(mon => String(mon.id) === pokemonId)) {
    throw new Error('That Pokémon is not on the selected team.');
  }

  const trainers = draft.trainers.map((team, index) => {
    if (index !== trainerIndex) return team;
    return {
      ...team,
      roster: action === 'add'
        ? roster.concat([{ ...pokemon }])
        : roster.filter(mon => String(mon.id) !== pokemonId)
    };
  });
  const draftedIds = { ...(draft.draftedIds || {}) };

  if (action === 'add') {
    draftedIds[pokemonId] = { trainerIdx: trainerIndex, tier: pokemon.tier };
  } else {
    delete draftedIds[pokemonId];
  }

  return { ...draft, trainers, draftedIds };
}
