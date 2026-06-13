#!/usr/bin/env node
/**
 * Manual end-to-end smoke test for all five tools, against the LIVE site.
 *
 * ⚠️ This hits your real Leclerc Drive account: it adds one item to your cart,
 * reads/updates it, then removes it (cleans up after itself). Run it only with
 * your own session. Requires `npm run build` first and Chrome logged into
 * Leclerc Drive (or LECLERC_COOKIE set).
 *
 *   npm run build && npm run smoke [search-term]
 */

import { createCookieProvider } from "../dist/auth/cookies.js";
import { loadConfig } from "../dist/config.js";
import { LeclercClient } from "../dist/leclerc/client.js";

const term = process.argv[2] || "café";
const config = loadConfig();
const client = new LeclercClient(config, createCookieProvider(config));

const showCart = (label, c) =>
  console.log(
    `${label}: ${c.itemCount} item(s), ${c.total} EUR — ` +
      (c.items.map((i) => `${i.quantity}x ${i.product.label} [${i.product.id}] =${i.lineTotal}`).join(" | ") ||
        "(empty)"),
  );

console.log(`Store ${config.storeId} @ ${config.host}\n`);

console.log(`1) search_product("${term}")`);
const products = await client.searchProducts(term);
console.log(`   → ${products.length} products`);
const target = products.find((p) => p.available);
if (!target) throw new Error("No available product found to test the cart with.");
console.log(`   using: ${target.label} [${target.id}] @ ${target.price} EUR\n`);

console.log(`2) add_to_cart(${target.id}, 2)`);
showCart("   cart", await client.addToCart(target.id, 2));

console.log(`\n3) get_cart()`);
showCart("   cart", await client.getCart());

console.log(`\n4) update_quantity(${target.id}, 1)`);
showCart("   cart", await client.updateQuantity(target.id, 1));

console.log(`\n5) remove_from_cart(${target.id})`);
showCart("   cart", await client.removeFromCart(target.id));

console.log(`\n6) get_cart() — should be empty`);
showCart("   cart", await client.getCart());

console.log("\n✓ smoke test complete (cart cleaned up).");
