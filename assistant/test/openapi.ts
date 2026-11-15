import openapi from "../../crates/oryxa-fde-api/openapi.json" with { type: "json" };

// The API's own description of its routes (`crates/oryxa-fde-api/openapi.json`), and a checker for the small part of
// JSON Schema it uses, so what the Worker writes to the record is checked against the API's very shapes: in the
// shape tests, and by the sample API on every write a test makes. A drift on either side fails a test.

type Schema = {
  $ref?: string;
  type?: string | Array<string>;
  enum?: Array<unknown>;
  oneOf?: Array<Schema>;
  required?: Array<string>;
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  minimum?: number;
};

const schemas = (openapi as unknown as { components: { schemas: Record<string, Schema> } }).components.schemas;

/** One of the API's named schemas, as openapi.json has it. */
export function schemaOf(name: string): Schema {
  const found = schemas[name];
  if (found === undefined) throw new Error(`openapi.json has no schema ${name}`);
  return found;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** Where `value` breaks `schema`, as JSON paths with what broke; empty when it fits. */
export function problems(value: unknown, schema: Schema, at = "$"): Array<string> {
  if (schema.$ref !== undefined) return problems(value, schemaOf(schema.$ref.split("/").at(-1)!), at);
  if (schema.oneOf !== undefined) {
    const fits = schema.oneOf.filter((s) => problems(value, s, at).length === 0).length;
    return fits === 1 ? [] : [`${at}: fits ${fits} of oneOf`];
  }
  const out: Array<string> = [];
  if (schema.enum !== undefined && !schema.enum.includes(value))
    out.push(`${at}: not one of ${schema.enum.join(", ")}`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      return [...out, `${at}: ${actual}, not ${types.join(" or ")}`];
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: too small`);
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((v, i) => out.push(...problems(v, schema.items!, `${at}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) out.push(`${at}.${key}: missing`);
    for (const [key, v] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property !== undefined) out.push(...problems(v, property, `${at}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${key}: not allowed`);
    }
  }
  return out;
}
