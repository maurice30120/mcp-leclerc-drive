/** Garde-fous sécurité : ids hallucinés, host Leclerc, checkout interdit, gate mutation. */
import { test, assert } from './helpers.ts';
import {
  isTrustworthyProductId,
  productIdExistsInResults,
  planHasNoHallucinatedId,
  hostIsLeclerc,
  isForbiddenCheckoutIntent,
  isForbiddenCredentialStorage,
  MutationGuard,
} from '../src/features/safety/guards.ts';
import type { Plan } from '../src/features/ai/plan.ts';
import type { Product } from '../src/shared/types.ts';

const LECLERC_HOST = 'fd9-courses.leclercdrive.fr';

test('isTrustworthyProductId : seul le canal de recherche est fiable', () => {
  assert.equal(isTrustworthyProductId('leclerc_search'), true);
  assert.equal(isTrustworthyProductId('model_hallucination'), false);
});

test('productIdExistsInResults : vrai si présent dans les résultats', () => {
  const results: Product[] = [{ id: 'p1', label: 'Lait', price: 1.2, available: true }];
  assert.equal(productIdExistsInResults('p1', results), true);
  assert.equal(productIdExistsInResults('p999', results), false);
});

test('planHasNoHallucinatedId : nettoyé => ok', () => {
  const plan: Plan = { items: [{ query: 'lait', quantity: 1 }] };
  const r = planHasNoHallucinatedId(plan);
  assert.equal(r.ok, true);
});

test('planHasNoHallucinatedId : id restant => offender', () => {
  const plan: Plan = {
    items: [{ query: 'lait', quantity: 1, ...({ product_id: '123' } as object) } as never],
  } as Plan;
  const r = planHasNoHallucinatedId(plan);
  assert.equal(r.ok, false);
  assert.equal(r.offenders.length, 1);
});

test('hostIsLeclerc', () => {
  assert.equal(hostIsLeclerc(LECLERC_HOST), true);
  assert.equal(hostIsLeclerc('evil.example.com'), false);
  assert.equal(hostIsLeclerc(undefined), false);
});

test('isForbiddenCheckoutIntent', () => {
  assert.equal(isForbiddenCheckoutIntent('valider ma commande'), true);
  assert.equal(isForbiddenCheckoutIntent('payer le panier'), true);
  assert.equal(isForbiddenCheckoutIntent('ajoute du lait'), false);
});

test('isForbiddenCredentialStorage', () => {
  assert.equal(isForbiddenCredentialStorage('enregistre mon mot de passe'), true);
  assert.equal(isForbiddenCredentialStorage('stocke ma carte bancaire'), true);
  assert.equal(isForbiddenCredentialStorage('ajoute du lait'), false);
});

test('MutationGuard : refus tant que non confirmé, puis accepte puis consomme', () => {
  const g = new MutationGuard();
  assert.equal(g.canMutate('n1'), false);
  g.confirm('n1');
  assert.equal(g.canMutate('n1'), true);
  assert.equal(g.canMutate('n1'), false); // consommé (anti-rejeu)
  assert.equal(g.hasPending(), false);
});