/** searchCallsForPlan + addToCartCallsForSelections. */
import { test, assert } from './helpers.ts';
import {
  searchCallsForPlan,
  addToCartCallsForSelections,
  type ProductSelection,
} from '../src/features/mcp/workflow.ts';
import type { Plan } from '../src/features/ai/plan.ts';

const plan: Plan = {
  items: [
    { query: 'lait', quantity: 2 },
    { query: 'pâtes', quantity: 1 },
  ],
};

test('searchCallsForPlan : une recherche par item', () => {
  const calls = searchCallsForPlan(plan);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'search_products');
  assert.equal(calls[0].args.query, 'lait');
});

test('addToCartCallsForSelections : happy path', () => {
  const selections: ProductSelection[] = [
    { itemIndex: 0, productId: 'p1', quantity: 2 },
    { itemIndex: 1, productId: 'p2' },
  ];
  const r = addToCartCallsForSelections(plan, selections);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[0].args.product_id, 'p1');
    assert.equal(r.calls[0].args.quantity, 2);
    assert.equal(r.calls[1].args.quantity, 1);
  }
});

test('sélection incomplète => erreur', () => {
  const r = addToCartCallsForSelections(plan, [{ itemIndex: 0, productId: 'p1' }]);
  assert.equal(r.ok, false);
});

test('productId manquant => erreur', () => {
  const r = addToCartCallsForSelections(plan, [
    { itemIndex: 0, productId: '   ' },
    { itemIndex: 1, productId: 'p2' },
  ]);
  assert.equal(r.ok, false);
});

test('index hors bornes => erreur', () => {
  const r = addToCartCallsForSelections(plan, [{ itemIndex: 99, productId: 'p' }]);
  assert.equal(r.ok, false);
});