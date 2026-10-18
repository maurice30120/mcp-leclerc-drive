/**
 * Minimal JSON-Schema (draft-07 subset) types used by capability contracts.
 *
 * Kept local on purpose: the contracts package has zero dependencies, and the
 * schemas are consumed for WebMCP projection and documentation, while actual
 * input validation is performed by the colocated `validateInput` of each
 * contract — one definition file per capability, one source of truth.
 */

export type JsonSchemaType =
  | "object"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "array";

export interface JsonSchemaProperty {
  type: JsonSchemaType;
  description?: string;
  minimum?: number;
  default?: number;
  items?: { type: JsonSchemaType };
  required?: string[];
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}
