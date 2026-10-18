/**
 * WebMCP projection of the @leclerc/contracts registry (issue #50).
 *
 * Pure data transform: a capability contract becomes a WebMCP tool
 * descriptor (name, title, description, inputSchema, annotations). No
 * chrome / Node / MCP runtime dependency here — execute() binding stays in
 * extension/inject.ts, and WebMCP in the connected tab remains the only MCP
 * surface (ADR-0001/0002: no Node stdio server).
 *
 * The external WebMCP surface is frozen to the historical hand-written
 * registrations:
 *  - tool names and external input field names are unchanged: the registry
 *    validates camelCase internally (storeId, productId) but set_store is
 *    the single rename (contract `storeId` -> external `store_id`), plus its
 *    historical external-only optional `host` property;
 *  - annotations follow the per-kind conventions: read -> readOnlyHint,
 *    catalogue-facing reads -> untrustedContentHint, cart mutations keep
 *    their per-tool destructive/idempotent hints, openWorldHint everywhere
 *    it existed before (all but get_store).
 */
import type { CapabilityKind, JsonSchemaObject, JsonSchemaProperty } from "@leclerc/contracts";

/** Structural subset of a registry contract consumed by the projection. */
export interface ProjectableCapability {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: CapabilityKind;
  readonly inputSchema: JsonSchemaObject;
}

/** WebMCP tool annotations (mcp-b hints + 2025-06-18 spec hints). */
export interface WebmcpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  untrustedContentHint?: boolean;
  openWorldHint?: boolean;
}

/** WebMCP tool descriptor produced from a registry contract (no execute). */
export interface ProjectedWebmcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations: WebmcpToolAnnotations;
}

// ---- external naming (frozen surface) --------------------------------------

/** Contract property -> external WebMCP property, per capability. */
const EXTERNAL_PROPERTY_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  set_store: { storeId: "store_id" },
};

/**
 * External-only properties the registry does not model, kept for backward
 * compatibility of the WebMCP surface (set_store's optional backend host).
 */
const EXTERNAL_ONLY_PROPERTIES: Readonly<
  Record<string, Readonly<Record<string, JsonSchemaProperty>>>
> = {
  set_store: {
    host: {
      type: "string",
      description:
        "Host backend optionnel (fdN-courses.leclercdrive.fr). Requis si pas issu de find_stores.",
    },
  },
};

/**
 * External WebMCP property name for a contract property of the given
 * capability (identity when the projection performs no rename). Single
 * source of the frozen external naming — inject.ts's set_store executor
 * consumes it to translate external (WebMCP) args back to contract form.
 */
export function externalPropertyName(capabilityName: string, contractProperty: string): string {
  return EXTERNAL_PROPERTY_RENAMES[capabilityName]?.[contractProperty] ?? contractProperty;
}

// ---- annotations ------------------------------------------------------------

/** Tools whose output carries Leclerc catalogue content (untrusted for models). */
const UNTRUSTED_CONTENT_CAPABILITIES: ReadonlySet<string> = new Set([
  "search_product",
  "find_stores",
  "list_habitual_products",
]);

/**
 * Per-tool cart-mutation conventions: add/update are idempotent quantity
 * sets (non-destructive), remove destroys the cart line.
 */
const MUTATION_ANNOTATIONS: Readonly<
  Record<string, Pick<WebmcpToolAnnotations, "destructiveHint" | "idempotentHint">>
> = {
  add_to_cart: { destructiveHint: false, idempotentHint: true },
  update_quantity: { destructiveHint: false, idempotentHint: true },
  remove_from_cart: { destructiveHint: true },
};

/** openWorldHint was absent only for get_store in the historical registration. */
const CLOSED_WORLD_CAPABILITIES: ReadonlySet<string> = new Set(["get_store"]);

/**
 * Project a registry contract onto a WebMCP tool descriptor. The result is
 * fully detached from the contract: mutating it never touches the registry.
 */
export function projectWebmcpTool(contract: ProjectableCapability): ProjectedWebmcpTool {
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    inputSchema: projectInputSchema(contract),
    annotations: projectAnnotations(contract),
  };
}

function projectInputSchema(contract: ProjectableCapability): JsonSchemaObject {
  const renames = EXTERNAL_PROPERTY_RENAMES[contract.name] ?? {};
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [key, property] of Object.entries(contract.inputSchema.properties)) {
    properties[renames[key] ?? key] = { ...property };
  }
  for (const [key, property] of Object.entries(EXTERNAL_ONLY_PROPERTIES[contract.name] ?? {})) {
    properties[key] = { ...property };
  }
  const required = contract.inputSchema.required?.map((key) => renames[key] ?? key);
  return required === undefined
    ? { type: "object", properties }
    : { type: "object", properties, required };
}

function projectAnnotations(contract: ProjectableCapability): WebmcpToolAnnotations {
  const annotations: WebmcpToolAnnotations = {};
  if (contract.kind === "read") {
    annotations.readOnlyHint = true;
  }
  if (contract.kind === "mutation") {
    const hints = MUTATION_ANNOTATIONS[contract.name];
    if (hints === undefined) {
      throw new Error(
        `Projection WebMCP : la mutation '${contract.name}' n'a pas d'annotations déclarées.`,
      );
    }
    annotations.destructiveHint = hints.destructiveHint;
    if (hints.idempotentHint !== undefined) {
      annotations.idempotentHint = hints.idempotentHint;
    }
  }
  if (UNTRUSTED_CONTENT_CAPABILITIES.has(contract.name)) {
    annotations.untrustedContentHint = true;
  }
  if (!CLOSED_WORLD_CAPABILITIES.has(contract.name)) {
    annotations.openWorldHint = true;
  }
  return annotations;
}
