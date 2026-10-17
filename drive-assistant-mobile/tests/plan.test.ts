/** parsePlan / validatePlan — parsing + validation de la sortie modèle. */
import { test, assert } from './helpers.ts';
import { parsePlan, validatePlan, extractFirstJsonObject, MAX_QUANTITY } from '../src/features/ai/plan.ts';

test('parsePlan: accepte un JSON propre entouré de fences markdown', () => {
  const raw = '```json\n{"items":[{"query":"lait demi-écrémé bio","quantity":2}]}\n```';
  const r = parsePlan(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items.length, 1);
    assert.equal(r.plan.items[0].query, 'lait demi-écrémé bio');
    assert.equal(r.plan.items[0].quantity, 2);
  }
});

test('parsePlan: tolère du texte après le JSON', () => {
  const r = parsePlan('Voici le plan : {"items":[{"query":"pâtes","quantity":1}]} merci !');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.items[0].query, 'pâtes');
});

test('parsePlan: accepte un JSON doublement encodé en chaîne JSON', () => {
  const raw = JSON.stringify('{"items":[{"query":"salade grecque","quantity":1,"constraints":"100 g"}]}');
  const r = parsePlan(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items[0].query, 'salade grecque');
    assert.equal(r.plan.items[0].constraints, '100 g');
  }
});

test('parsePlan: rejette une sortie vide', () => {
  const r = parsePlan('   ');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /vide/i);
});

test('parsePlan: rejette une sortie sans objet JSON', () => {
  assert.equal(parsePlan('je ne peux pas faire de plan').ok, false);
});

test('validatePlan: exige un tableau items', () => {
  assert.equal(validatePlan({}).ok, false);
});

test('validatePlan: items vide + question => ok', () => {
  const r = validatePlan({ items: [], questions: ['Donne-moi les ingrédients.'] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.questions?.[0], 'Donne-moi les ingrédients.');
});

test('parsePlan: rejette un id halluciné au niveau item (product_id)', () => {
  // Même si product_id est présent, on ne PLANTE pas, mais on le nettoie :
  // l'item reste valide car query+quantity sont fournis. C'est safety/planHasNoHallucinatedId
  // qui capture l'invocation côté VM. Ici on vérifie le nettoyage défensif.
  const raw = '{"items":[{"query":"lait","quantity":1,"product_id":"12345"}]}';
  const r = parsePlan(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal((r.plan.items[0] as unknown as { product_id?: string }).product_id, undefined);
  }
});

test('parsePlan: borne la quantité > MAX_QUANTITY', () => {
  const r = parsePlan(`{"items":[{"query":"oeufs","quantity":${MAX_QUANTITY + 50}}]}`);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.items[0].quantity, MAX_QUANTITY);
});

test('parsePlan: rejette quantity 0', () => {
  const r = parsePlan('{"items":[{"query":"oeufs","quantity":0}]}');
  assert.equal(r.ok, false);
});

test('parsePlan: place une valeur placeholder → erreur', () => {
  const r = parsePlan('{"items":[{"query":"Terme de recherche catalogue","quantity":1}]}');
  assert.equal(r.ok, false);
});

test('extractFirstJsonObject: respecte les accolades dans les chaînes', () => {
  assert.equal(extractFirstJsonObject('x {"a":{"b":"}"}} y'), '{"a":{"b":"}"}}');
});