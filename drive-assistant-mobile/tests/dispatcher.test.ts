/** validateCommand + classification read/mutation. */
import { test, assert } from './helpers.ts';
import { validateCommand, isMutationCall, isReadCall } from '../src/features/mcp/dispatcher.ts';
import type { DispatchCall } from '../src/features/mcp/dispatcher.ts';

const LECLERC_HOST = 'fd9-courses.leclercdrive.fr';

test('search_products valide', () => {
  const r = validateCommand('search_products', { query: 'lait' }, LECLERC_HOST);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.call.command, 'search_products');
});

test('search_products rejette query vide', () => {
  assert.equal(validateCommand('search_products', { query: '   ' }, LECLERC_HOST).ok, false);
});

test('commande inconnue => erreur', () => {
  assert.equal(validateCommand('destroy_cart', {}, LECLERC_HOST).ok, false);
});

test('mutation sur host non-Leclerc => refus (SSRF)', () => {
  const r = validateCommand('add_to_cart', { product_id: '123', quantity: 1 }, 'evil.example.com');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /non-Leclerc/i);
});

test('add_to_cart valide', () => {
  const r = validateCommand('add_to_cart', { product_id: '123', quantity: 2 }, LECLERC_HOST);
  assert.equal(r.ok, true);
  if (r.ok && r.call.command === 'add_to_cart') {
    assert.equal(r.call.productId, '123');
    assert.equal(r.call.quantity, 2);
  }
});

test('add_to_cart quantity < 1 => erreur', () => {
  assert.equal(
    validateCommand('add_to_cart', { product_id: 'x', quantity: 0 }, LECLERC_HOST).ok,
    false,
  );
});

test('update_quantity quantity 0 autorisé (retire)', () => {
  const r = validateCommand('update_quantity', { product_id: 'x', quantity: 0 }, LECLERC_HOST);
  assert.equal(r.ok, true);
});

test('remove_from_cart sans quantity', () => {
  const r = validateCommand('remove_from_cart', { product_id: 'x' }, LECLERC_HOST);
  assert.equal(r.ok, true);
  if (r.ok && r.call.command === 'remove_from_cart') assert.equal(r.call.productId, 'x');
});

test('product_id manquant pour mutation => erreur', () => {
  assert.equal(validateCommand('add_to_cart', { quantity: 1 }, LECLERC_HOST).ok, false);
});

const mut: DispatchCall = { command: 'add_to_cart', productId: '1', quantity: 1 };
const read: DispatchCall = { command: 'get_cart' };
test('isMutationCall / isReadCall', () => {
  assert.equal(isMutationCall(mut), true);
  assert.equal(isReadCall(mut), false);
  assert.equal(isReadCall(read), true);
  assert.equal(isMutationCall(read), false);
});