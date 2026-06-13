#!/usr/bin/env node
/**
 * MCP server for E.Leclerc Drive.
 *
 * Exposes search / cart tools over stdio so Claude Desktop, Claude Code, or any
 * MCP client can drive grocery ordering natively instead of via browser
 * automation.
 *
 * The tool *contracts* are final; the underlying client (src/leclerc/client.ts)
 * still needs its endpoints wired up from a network capture — until then tools
 * return a clear "not reverse-engineered yet" error.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createCookieProvider } from "./auth/cookies.js";
import { cookieSourceOf, loadConfig } from "./config.js";
import { LeclercClient } from "./leclerc/client.js";
import { Cart, Product } from "./types.js";

// Single source of truth for the version: read it from package.json (one dir up
// from dist/index.js) so serverInfo never drifts from the published package.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const config = loadConfig();
const cookieProvider = createCookieProvider(config);
const client = new LeclercClient(config, cookieProvider);

const server = new McpServer({
  name: "mcp-leclerc-drive",
  version: pkg.version,
});

function formatProduct(p: Product): string {
  const bits = [
    p.label,
    p.brand ? `(${p.brand})` : null,
    `— ${p.price.toFixed(2)} €`,
    p.pricePerUnit ? `[${p.pricePerUnit}]` : null,
    p.nutriScore ? `Nutri-Score ${p.nutriScore}` : null,
    p.available ? null : "⚠️ indisponible",
    `id=${p.id}`,
  ].filter(Boolean);
  return bits.join(" ");
}

function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const lines = cart.items.map(
    (it) =>
      `• ${it.quantity}× ${it.product.label} — ${it.lineTotal.toFixed(2)} € ` +
      `(id=${it.product.id})`,
  );
  return (
    `Panier (magasin ${cart.storeId}) — ${cart.itemCount} article(s) :\n` +
    lines.join("\n") +
    `\n\nTotal : ${cart.total.toFixed(2)} €`
  );
}

/** Wrap a tool body so thrown errors become structured MCP error content. */
function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Erreur : ${message}` }], isError: true };
}

server.tool(
  "search_product",
  "Recherche des produits dans le catalogue Leclerc Drive du magasin configuré. " +
    "Retourne label, prix, prix au kilo/litre, Nutri-Score, disponibilité et l'id " +
    "à utiliser pour add_to_cart.",
  { query: z.string().describe("Termes de recherche, ex. 'lait demi-écrémé bio'") },
  async ({ query }) => {
    try {
      const products = await client.searchProducts(query);
      if (products.length === 0) return asText(`Aucun produit trouvé pour « ${query} ».`);
      return asText(products.map(formatProduct).join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "add_to_cart",
  "Ajoute un produit au panier. Utilise l'id retourné par search_product.",
  {
    product_id: z.string().describe("Identifiant produit (champ id de search_product)"),
    quantity: z.number().int().positive().default(1).describe("Quantité à ajouter"),
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.addToCart(product_id, quantity);
      return asText(`Ajouté.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "remove_from_cart",
  "Retire complètement un produit du panier.",
  { product_id: z.string().describe("Identifiant produit à retirer") },
  async ({ product_id }) => {
    try {
      const cart = await client.removeFromCart(product_id);
      return asText(`Retiré.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "update_quantity",
  "Modifie la quantité d'un produit déjà présent dans le panier.",
  {
    product_id: z.string().describe("Identifiant produit"),
    quantity: z.number().int().nonnegative().describe("Nouvelle quantité (0 pour retirer)"),
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.updateQuantity(product_id, quantity);
      return asText(`Quantité mise à jour.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  "get_cart",
  "Affiche le contenu complet du panier avec le total.",
  {},
  async () => {
    try {
      const cart = await client.getCart();
      return asText(formatCart(cart));
    } catch (err) {
      return asError(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  console.error(
    `mcp-leclerc-drive ready (store ${config.storeId} @ ${config.host}, ` +
      `cookie source: ${cookieSourceOf(config)})`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
