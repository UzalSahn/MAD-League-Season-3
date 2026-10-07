import assert from 'node:assert/strict';
import test from 'node:test';
import { getPokemonSpriteUrl } from '../pokemon-sprites.js';

test('PokeAPI sprite URLs resolve standard and alternate pool entries', () => {
  assert.equal(
    getPokemonSpriteUrl({ id: 3 }),
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/3.png'
  );
  assert.equal(
    getPokemonSpriteUrl({ id: 4 }),
    'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/10033.png'
  );
});

test('PokeAPI sprite lookup returns no URL for an unknown Pokémon', () => {
  assert.equal(getPokemonSpriteUrl({ id: 999999 }), null);
  assert.equal(getPokemonSpriteUrl(null), null);
});
