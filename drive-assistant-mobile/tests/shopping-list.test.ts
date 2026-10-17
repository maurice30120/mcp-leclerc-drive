/** normaliseur déterministe de liste de courses. */
import { test, assert } from './helpers.ts';
import { normalizeShoppingList } from '../src/features/ai/shopping-list.ts';

test('normalise une liste virgule', () => {
  const r = normalizeShoppingList('lait demi-écrémé 1L, pâtes, tomates x3');
  assert.ok(r && r.ok);
  if (r && r.ok) {
    assert.equal(r.plan.items.length, 3);
    assert.equal(r.plan.items[0].query, 'lait demi-écrémé');
    assert.equal(r.plan.items[0].constraints, '1 L');
    assert.equal(r.plan.items[2].quantity, 3);
  }
});

test('détecte les comptes unitaires (paquets)', () => {
  const r = normalizeShoppingList('2 paquets de beurre');
  assert.ok(r && r.ok);
  if (r && r.ok) {
    assert.equal(r.plan.items[0].quantity, 2);
    assert.match(String(r.plan.items[0].constraints ?? ''), /paquet/i);
  }
});

test('plat seul sans produits => question de recette', () => {
  const r = normalizeShoppingList('carbonara');
  assert.ok(r && r.ok);
  if (r && r.ok) {
    assert.equal(r.plan.items.length, 0);
    assert.match(r.plan.questions?.[0] ?? '', /ingrédients/i);
  }
});

test('plat avec ingrédients explicites => items', () => {
  const r = normalizeShoppingList('pâtes, lardons, œufs, parmesan, crème fraîche');
  assert.ok(r && r.ok);
  if (r && r.ok) assert.ok(r.plan.items.length >= 4);
});

test('poids en kg', () => {
  const r = normalizeShoppingList('500 g de farine, 1 kg de sucre');
  assert.ok(r && r.ok);
  if (r && r.ok) {
    assert.equal(r.plan.items[0].constraints, '500 g');
    assert.equal(r.plan.items[1].constraints, '1 kg');
  }
});

test('vide => null', () => {
  assert.equal(normalizeShoppingList('   '), null);
});