export function renderPokemonStats(container, games, trainers, currentUid, isCommissioner) {
  const editableUids = new Set(isCommissioner ? trainers.map(trainer => trainer.uid) : [currentUid]);

  function statsFor(game, uid) {
    if (!game.pokemonStats) game.pokemonStats = {};
    if (!Array.isArray(game.pokemonStats[uid])) game.pokemonStats[uid] = [];
    return game.pokemonStats[uid];
  }

  function distinctPokemonCount(uid) {
    return new Set(games.flatMap(game => statsFor(game, uid).map(stat => String(stat.pokemonId)))).size;
  }

  function draw(){
    container.innerHTML = '';
    const section = document.createElement('div');
    section.className = 'pokemon-match-stats';
    games.forEach((game, gameIdx) => {
      const gameCard = document.createElement('div');
      gameCard.className = 'pokemon-game-stats';
      const title = document.createElement('div');
      title.className = 'pokemon-game-stats-title';
      title.textContent = 'Game ' + (gameIdx + 1) + ' Pokémon';
      gameCard.appendChild(title);

      trainers.forEach(trainer => {
        const team = document.createElement('fieldset');
        team.className = 'pokemon-stats-team';
        const legend = document.createElement('legend');
        legend.textContent = trainer.name;
        team.appendChild(legend);
        const editable = editableUids.has(trainer.uid);
        const selected = statsFor(game, trainer.uid);
        const selectedIds = new Set(selected.map(stat => String(stat.pokemonId)));
        const selectedLabel = document.createElement('div');
        selectedLabel.className = 'pokemon-stats-count';
        function updateSelectedLabel(){
          selectedLabel.textContent = selectedIds.size + ' / 4 Pokémon selected · ' + distinctPokemonCount(trainer.uid) + ' / 6 unique this match';
        }
        updateSelectedLabel();
        team.appendChild(selectedLabel);

        (trainer.roster || []).forEach(mon => {
          const id = String(mon.id);
          const row = document.createElement('div');
          row.className = 'pokemon-stats-row';
          const pickLabel = document.createElement('label');
          pickLabel.className = 'pokemon-stats-pick';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selectedIds.has(id);
          checkbox.disabled = !editable;
          const monName = mon.name + (mon.variation ? ' (' + mon.variation + ')' : '');
          const name = document.createElement('span');
          name.textContent = monName;
          pickLabel.appendChild(checkbox);
          pickLabel.appendChild(name);
          row.appendChild(pickLabel);

          const currentStats = selected.find(stat => String(stat.pokemonId) === id);
          if(currentStats || editable){
            const kills = document.createElement('input');
            kills.type = 'number';
            kills.min = '0';
            kills.max = '6';
            kills.step = '1';
            kills.value = currentStats ? currentStats.kills : '0';
            kills.placeholder = 'K';
            kills.disabled = !editable || !checkbox.checked;
            kills.setAttribute('aria-label', monName + ' kills in Game ' + (gameIdx + 1));
            kills.title = 'Kills';
            const deaths = document.createElement('input');
            deaths.type = 'number';
            deaths.min = '0';
            deaths.max = '1';
            deaths.step = '1';
            deaths.value = currentStats ? currentStats.deaths : '0';
            deaths.placeholder = 'D';
            deaths.disabled = !editable || !checkbox.checked;
            deaths.setAttribute('aria-label', monName + ' deaths in Game ' + (gameIdx + 1));
            deaths.title = 'Deaths';
            kills.addEventListener('input', () => {
              const stat = selected.find(item => String(item.pokemonId) === id);
              if(stat) stat.kills = kills.value === '' ? '' : Number(kills.value);
            });
            deaths.addEventListener('input', () => {
              const stat = selected.find(item => String(item.pokemonId) === id);
              if(stat) stat.deaths = deaths.value === '' ? '' : Number(deaths.value);
            });
            checkbox.addEventListener('change', () => {
              if(checkbox.checked){
                if(selectedIds.size >= 4){
                  checkbox.checked = false;
                  alert('Select exactly four Pokémon per game.');
                  return;
                }
                if(!selectedIds.has(id) && distinctPokemonCount(trainer.uid) >= 6){
                  checkbox.checked = false;
                  alert('You can select no more than six unique Pokémon across the match.');
                  return;
                }
                selectedIds.add(id);
                selected.push({ pokemonId: mon.id, name: mon.name, variation: mon.variation || '', kills: 0, deaths: 0 });
              } else {
                selectedIds.delete(id);
                const index = selected.findIndex(stat => String(stat.pokemonId) === id);
                if(index >= 0) selected.splice(index, 1);
              }
              kills.disabled = !editable || !checkbox.checked;
              deaths.disabled = !editable || !checkbox.checked;
              updateSelectedLabel();
            });
            row.appendChild(kills);
            row.appendChild(deaths);
          } else {
            checkbox.addEventListener('change', () => {
              checkbox.checked = false;
            });
          }
          team.appendChild(row);
        });
        gameCard.appendChild(team);
      });
      section.appendChild(gameCard);
    });
    container.appendChild(section);
  }

  draw();

  function validate(uid){
    const trainer = trainers.find(item => item.uid === uid);
    if(!trainer) throw new Error('Could not find the team for these Pokémon stats.');
    const totalUnique = distinctPokemonCount(uid);
    if(totalUnique > 6) throw new Error('No more than six unique Pokémon can be selected across a match.');
    games.forEach((game, gameIdx) => {
      const stats = statsFor(game, uid);
      if(stats.length !== 4) throw new Error(trainer.name + ' must select exactly four Pokémon for Game ' + (gameIdx + 1) + '.');
    });
  }

  return {
    validate,
    save: async onSave => {
      const updates = {};
      for(const uid of editableUids){
        const totalUnique = distinctPokemonCount(uid);
        if(totalUnique === 0) continue;
        validate(uid);
        games.forEach((game, gameIdx) => {
          const stats = statsFor(game, uid);
          stats.forEach(stat => {
            if(!Number.isInteger(stat.kills) || stat.kills < 0 || stat.kills > 6) {
              throw new Error('Kills must be a whole number from 0 to 6.');
            }
            if(!Number.isInteger(stat.deaths) || stat.deaths < 0 || stat.deaths > 1) {
              throw new Error('Deaths must be 0 or 1.');
            }
          });
          updates[uid] = updates[uid] || [];
          updates[uid].push({ gameIdx, stats: JSON.parse(JSON.stringify(stats)) });
        });
      }
      await onSave(updates);
    }
  };
}

export function calculatePokemonMvpRace(league) {
  const pokemon = new Map();
  const trainersByUid = new Map((league.draft && league.draft.trainers || []).map(trainer => [trainer.uid, trainer]));
  const addPokemon = mon => {
    if(mon && mon.id != null && !pokemon.has(String(mon.id))){
      pokemon.set(String(mon.id), {
        id: mon.id,
        name: mon.name || 'Pokémon #' + mon.id,
        variation: mon.variation || '',
        ownerUid: null,
        gamesPlayed: 0,
        kills: 0,
        deaths: 0
      });
    }
  };
  const currentTeamOwners = new Map();
  (league.draft && league.draft.trainers || []).forEach(trainer => (trainer.roster || []).forEach(mon => {
    addPokemon(mon);
    currentTeamOwners.set(String(mon.id), trainer.uid);
  }));
  (league.transactionLog || []).forEach(log => {
    (log.claims || []).forEach(addPokemon);
    (log.drops || []).forEach(addPokemon);
    (log.offered || []).forEach(addPokemon);
    (log.requested || []).forEach(addPokemon);
    addPokemon(log.pokemon);
  });
  (league.draft && league.draft.history || []).forEach(pick => {
    if(pick.mon) addPokemon(pick.mon);
    if(!pokemon.has(String(pick.monId))){
      pokemon.set(String(pick.monId), {
        id: pick.monId,
        name: 'Pokémon #' + pick.monId,
        variation: '',
        ownerUid: null,
        gamesPlayed: 0,
        kills: 0,
        deaths: 0
      });
    }
  });

  function collectGames(games, teamUids) {
    (games || []).forEach(game => {
      const statsByTrainerUid = game.pokemonStats || {};
      teamUids.forEach(uid => {
        (statsByTrainerUid[uid] || []).forEach(stat => {
          const entry = pokemon.get(String(stat.pokemonId));
          if(!entry) return;
          entry.gamesPlayed++;
          entry.kills += Number(stat.kills) || 0;
          entry.deaths += Number(stat.deaths) || 0;
          entry.ownerUid = uid;
        });
      });
    });
  }

  const schedule = league.schedule || {};
  Object.keys(schedule.results || {}).forEach(key => {
    const parts = key.match(/^(\d+)_(\d+)$/);
    if(!parts) return;
    const match = schedule.weeks && schedule.weeks[Number(parts[1])] && schedule.weeks[Number(parts[1])].matches[Number(parts[2])];
    const result = schedule.results[key];
    if(match && result && result.locked) collectGames(result.games, [match.a, match.b]);
  });
  const bracket = league.playoffBracket;
  if(bracket && Array.isArray(bracket.rounds)){
    bracket.rounds.forEach(round => (round.matches || []).forEach(match => {
      if(match.locked) collectGames(match.games, [match.a, match.b]);
    }));
  }

  return Array.from(pokemon.values()).map(entry => {
    const ownerUid = currentTeamOwners.get(String(entry.id)) || entry.ownerUid;
    return {
      ...entry,
      trainerName: ownerUid && trainersByUid.get(ownerUid) ? trainersByUid.get(ownerUid).name : '—',
      differential: entry.kills - entry.deaths
    };
  }).sort((a, b) =>
    b.kills - a.kills
    || b.gamesPlayed - a.gamesPlayed
    || b.differential - a.differential
    || a.name.localeCompare(b.name)
    || String(a.variation).localeCompare(String(b.variation))
  );
}
