/**
 * WebMCP projection of the @leclerc/contracts registry (issue #50).
 *
 * Pure data transform: registry contract -> WebMCP tool descriptor. The
 * external surface must stay identical to the historical hand-written
 * registrations in extension/inject.ts: same nine tool names, same external
 * input field names (query, product_id, quantity, store_id + host), same
 * annotation conventions (readOnlyHint on reads, untrustedContentHint on
 * catalogue-facing tools, per-tool destructive/idempotent hints on cart
 * mutations, openWorldHint everywhere except get_store).
 */
import { test, assert } from "./helpers.ts";
import { CAPABILITIES } from "@leclerc/contracts";
import { projectWebmcpTool } from "../src/webmcp/projection.ts";

const tools = CAPABILITIES.map(projectWebmcpTool);
const byName = new Map(tools.map((t) => [t.name, t]));

function tool(name: string) {
  const t = byName.get(name);
  assert.ok(t, `capacité ${name} non projetée`);
  return t;
}

test("projection: covers exactly the nine registry capabilities, in registry order", () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "find_stores",
      "set_store",
      "get_store",
      "search_product",
      "list_habitual_products",
      "get_cart",
      "add_to_cart",
      "update_quantity",
      "remove_from_cart",
    ],
  );
});

test("projection: name, title and description come from the contract", () => {
  const search = tool("search_product");
  assert.equal(search.title, "Rechercher un produit");
  assert.ok(
    search.description.includes("ne sont pas fiables"),
    "la description doit avertir que les libellés du catalogue ne sont pas fiables",
  );
  const find = tool("find_stores");
  assert.ok(find.description.includes("set_store"), "find_stores doit pointer vers set_store");
});

test("projection: search_product keeps the external 'query' field, required", () => {
  const t = tool("search_product");
  assert.deepEqual(Object.keys(t.inputSchema.properties), ["query"]);
  assert.deepEqual(t.inputSchema.required, ["query"]);
  assert.equal(t.inputSchema.properties.query?.type, "string");
});

test("projection: add_to_cart keeps product_id + optional quantity (min 1, default 1)", () => {
  const t = tool("add_to_cart");
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["product_id", "quantity"]);
  assert.deepEqual(t.inputSchema.required, ["product_id"]);
  assert.equal(t.inputSchema.properties.quantity?.minimum, 1);
  assert.equal(t.inputSchema.properties.quantity?.default, 1);
});

test("projection: update_quantity keeps product_id + required quantity (min 0)", () => {
  const t = tool("update_quantity");
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["product_id", "quantity"]);
  assert.deepEqual(t.inputSchema.required, ["product_id", "quantity"]);
  assert.equal(t.inputSchema.properties.quantity?.minimum, 0);
});

test("projection: remove_from_cart keeps product_id alone, required", () => {
  const t = tool("remove_from_cart");
  assert.deepEqual(Object.keys(t.inputSchema.properties), ["product_id"]);
  assert.deepEqual(t.inputSchema.required, ["product_id"]);
});

test("projection: find_stores keeps the external 'query' field, required", () => {
  const t = tool("find_stores");
  assert.deepEqual(Object.keys(t.inputSchema.properties), ["query"]);
  assert.deepEqual(t.inputSchema.required, ["query"]);
});

test("projection: set_store exposes store_id (+ optional host), never the contract storeId", () => {
  const t = tool("set_store");
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["host", "store_id"]);
  assert.deepEqual(t.inputSchema.required, ["store_id"]);
  assert.equal(t.inputSchema.properties.host?.type, "string");
});

test("projection: no-arg capabilities keep an empty object schema", () => {
  for (const name of ["get_cart", "get_store", "list_habitual_products"]) {
    assert.deepEqual(tool(name).inputSchema.properties, {}, name);
  }
});

test("projection: no camelCase contract key leaks to the external surface", () => {
  const external = new Set(["query", "product_id", "quantity", "store_id", "host"]);
  for (const t of tools) {
    for (const key of Object.keys(t.inputSchema.properties)) {
      assert.ok(external.has(key), `${t.name}: champ externe inattendu '${key}'`);
    }
    for (const key of t.inputSchema.required ?? []) {
      assert.ok(external.has(key), `${t.name}: champ requis inattendu '${key}'`);
    }
  }
});

test("projection: read capabilities carry readOnlyHint", () => {
  for (const name of [
    "search_product",
    "find_stores",
    "get_cart",
    "get_store",
    "list_habitual_products",
  ]) {
    assert.equal(tool(name).annotations.readOnlyHint, true, name);
  }
});

test("projection: catalogue-facing reads carry untrustedContentHint, others do not", () => {
  for (const name of ["search_product", "find_stores", "list_habitual_products"]) {
    assert.equal(tool(name).annotations.untrustedContentHint, true, name);
  }
  for (const name of [
    "set_store",
    "get_store",
    "get_cart",
    "add_to_cart",
    "update_quantity",
    "remove_from_cart",
  ]) {
    assert.equal(tool(name).annotations.untrustedContentHint, undefined, name);
  }
});

test("projection: add_to_cart/update_quantity are non-destructive idempotent mutations", () => {
  for (const name of ["add_to_cart", "update_quantity"]) {
    const a = tool(name).annotations;
    assert.equal(a.destructiveHint, false, name);
    assert.equal(a.idempotentHint, true, name);
    assert.equal(a.readOnlyHint, undefined, name);
  }
});

test("projection: remove_from_cart is destructive, never flagged read-only", () => {
  const a = tool("remove_from_cart").annotations;
  assert.equal(a.destructiveHint, true);
  assert.equal(a.idempotentHint, undefined);
  assert.equal(a.readOnlyHint, undefined);
});

test("projection: set_store is a session change (no read/destructive hint)", () => {
  const a = tool("set_store").annotations;
  assert.equal(a.readOnlyHint, undefined);
  assert.equal(a.destructiveHint, undefined);
  assert.equal(a.idempotentHint, undefined);
});

test("projection: openWorldHint everywhere except get_store", () => {
  for (const t of tools) {
    const expected = t.name === "get_store" ? undefined : true;
    assert.equal(t.annotations.openWorldHint, expected, t.name);
  }
});

test("projection: no capability is both read-only and destructive", () => {
  for (const t of tools) {
    const a = t.annotations;
    assert.ok(!(a.readOnlyHint && a.destructiveHint), `${t.name}: readOnly + destructif`);
  }
});

test("projection: output is detached from the registry (fresh schema objects)", () => {
  const setStore = CAPABILITIES.find((c) => c.name === "set_store");
  assert.ok(setStore);
  const first = projectWebmcpTool(setStore);
  assert.notEqual(first.inputSchema, setStore.inputSchema);
  assert.notEqual(first.inputSchema.properties.store_id, setStore.inputSchema.properties.storeId);
  first.inputSchema.properties.store_id.description = "altéré";
  const second = projectWebmcpTool(setStore);
  assert.notEqual(
    second.inputSchema.properties.store_id.description,
    "altéré",
    "le registre ne doit pas être modifiable via le descripteur projeté",
  );
});

test("projection: unknown mutation capability fails loudly (no silent annotation drop)", () => {
  assert.throws(
    () =>
      projectWebmcpTool({
        name: "mutation_mystere",
        title: "t",
        description: "d",
        kind: "mutation",
        inputSchema: { type: "object", properties: {} },
      }),
    /mutation_mystere/,
  );
});
