import type { Args, JsonSchema } from "./types.ts";

export type Parsed = { ok: true; value: Args } | { ok: false; error: string };

/** JSON.parse + a strict check against the small JSON-schema subset tools use. */
export function parseArgs(raw: string, schema: JsonSchema): Parsed {
  let value: unknown;
  try {
    value = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "arguments must be an object" };
  const record = value as Args;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined || record[key] === null) return { ok: false, error: `missing ${key}` };
  }
  for (const [key, item] of Object.entries(record)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) return { ok: false, error: `unknown field ${key}` };
      continue;
    }
    if (item === undefined || item === null) continue;
    if (prop.type === "string") {
      if (typeof item !== "string") return { ok: false, error: `${key} must be a string` };
      if (prop.maxLength !== undefined && item.length > prop.maxLength) return { ok: false, error: `${key} longer than ${prop.maxLength}` };
      if (prop.enum && !prop.enum.includes(item)) return { ok: false, error: `${key} must be one of ${prop.enum.join(", ")}` };
    } else if (prop.type === "boolean") {
      if (typeof item !== "boolean") return { ok: false, error: `${key} must be a boolean` };
    } else if (prop.type === "array") {
      if (!Array.isArray(item)) return { ok: false, error: `${key} must be an array` };
      if (prop.maxItems !== undefined && item.length > prop.maxItems) return { ok: false, error: `${key} has more than ${prop.maxItems} items` };
      if (prop.items?.type === "string" && item.some((x) => typeof x !== "string" || (prop.items!.enum && !prop.items!.enum.includes(x)))) return { ok: false, error: `${key} items must be ${prop.items.enum ? `one of ${prop.items.enum.join(", ")}` : "strings"}` };
    } else if (prop.type === "object") {
      if (typeof item !== "object" || Array.isArray(item)) return { ok: false, error: `${key} must be an object` };
    } else if (prop.type !== "number" && prop.type !== "integer") {
      // Untyped/union props (external MCP schemas): the server validates them.
      continue;
    } else {
      if (typeof item !== "number" || !Number.isFinite(item)) return { ok: false, error: `${key} must be a number` };
      if (prop.type === "integer" && !Number.isInteger(item)) return { ok: false, error: `${key} must be an integer` };
      if (prop.minimum !== undefined && item < prop.minimum) return { ok: false, error: `${key} below ${prop.minimum}` };
      if (prop.maximum !== undefined && item > prop.maximum) return { ok: false, error: `${key} above ${prop.maximum}` };
    }
  }
  return { ok: true, value: record };
}
