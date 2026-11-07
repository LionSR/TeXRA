/**
 * Provider-neutral tool parameter schemas: a tool definition's Effect Schema
 * or pre-built JSON Schema, normalized to the object shape every
 * function-calling API accepts (top-level unions flattened, a fieldless
 * struct given an object root, the dialect URI stripped, every array given an
 * `items`). The tool catalog builds the package's uniform tool definitions
 * from it; the structured-output tool builder shares it.
 */
import { type JsonSchema, Predicate, Schema, SchemaAST } from 'effect';

import type { ToolDefinition } from '@shared/schemas';

/** A JSON Schema node as a provider's function-calling API reads it. */
export interface JSONSchemaObject {
  type?: string | string[];
  properties?: Record<string, JSONSchemaObject>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  oneOf?: JSONSchemaObject[];
  anyOf?: JSONSchemaObject[];
  allOf?: JSONSchemaObject[];
  items?: JSONSchemaObject | JSONSchemaObject[];
  $ref?: string;
  $schema?: string;
  $defs?: Record<string, JSONSchemaObject>;
  definitions?: Record<string, JSONSchemaObject>;
  additionalProperties?: boolean | JSONSchemaObject;
  [key: string]: unknown;
}

/** The one value a schema admits (`const`, a one-member `enum`), read
 *  through the `anyOf` a nullable optional field wraps it in: a branch's
 *  discriminator that takes a default is `Schema.optional(Schema.NullOr(L))`. */
function schemaLiteralValue(schema: JSONSchemaObject): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return schema.enum[0];
  }
  const members = schema.anyOf?.filter((member) => member.type !== 'null');
  return members?.length === 1 ? schemaLiteralValue(members[0]) : undefined;
}

/** A field's description, its value schema and whether it admits `null`:
 *  the schema with its description and its `null` member taken off, which is
 *  what one field's copies on different branches are compared by. */
function splitField(schema: JSONSchemaObject): {
  readonly description: string | undefined;
  readonly shape: JSONSchemaObject;
  readonly nullable: boolean;
} {
  const { description, anyOf, ...rest } = schema;
  const members = anyOf?.filter((member) => member.type !== 'null');
  const admitsNull = anyOf?.some((member) => member.type === 'null') ?? false;
  if (members === undefined || members.length === 0) {
    return {
      description,
      shape: anyOf ? { ...rest, anyOf } : rest,
      nullable: false,
    };
  }
  if (members.length > 1) {
    return {
      description,
      shape: { ...rest, anyOf: members },
      nullable: admitsNull,
    };
  }
  const { description: inner, ...member } = members[0];
  return {
    description: description ?? inner,
    shape: { ...rest, ...member },
    nullable: admitsNull,
  };
}

/** "a", "a or b", "a, b, or c": the discriminator values a field is used with. */
const DISJUNCTION = new Intl.ListFormat('en', { type: 'disjunction' });

/** `schema` that also admits `null`. */
const nullable = (schema: JSONSchemaObject): JSONSchemaObject => ({
  anyOf: [
    ...(Object.keys(schema).length === 1 && schema.anyOf
      ? schema.anyOf
      : [schema]),
    { type: 'null' },
  ],
});

/** The property every branch pins to its own literal, with each branch's
 *  value, if the union has one. */
function discriminatorOf(
  branches: readonly Record<string, JSONSchemaObject>[],
): { readonly name: string; readonly values: unknown[] } | undefined {
  for (const name of Object.keys(branches[0])) {
    const values = branches.map((properties) =>
      properties[name] === undefined
        ? undefined
        : schemaLiteralValue(properties[name]),
    );
    if (
      values.every(Predicate.isNotUndefined) &&
      new Set(values).size === values.length
    ) {
      return { name, values };
    }
  }
  return undefined;
}

/**
 * Function-calling APIs reject a parameters schema whose top-level node is
 * `oneOf`/`anyOf` (HTTP 400: `schema must have type 'object' and not
 * contain 'oneOf'/'anyOf'/'allOf' at the top level`), and Effect Schema
 * emits a union of structs as a top-level `anyOf`. So a tool's input is
 * written as its natural union of tagged structs, dispatch decodes with that
 * union, and the model is shown one object built from it here:
 *
 * - the discriminator (the property every branch pins to a literal of its
 *   own) as an `enum` of those literals, each branch's description under its
 *   value;
 * - every other branch property once, a field two branches spell differently
 *   as the `anyOf` of their shapes, its description labelled with the
 *   discriminator values that take it unless every branch shares it;
 * - `required` only for a property every branch requires, and every other
 *   property nullable, since a field another branch requires is optional
 *   here and OpenAI-compatible APIs send an omitted field as `null` (a
 *   branch's struct ignores the keys it does not declare).
 */
function flattenTopLevelUnion(schema: JSONSchemaObject): JSONSchemaObject {
  if (schema.type === 'object') return schema;
  const variants = schema.anyOf ?? schema.oneOf;
  if (
    variants === undefined ||
    variants.length === 0 ||
    !variants.every((v) => Predicate.isObject(v) && v.type === 'object')
  ) {
    return schema;
  }

  const branches = variants.map((v) => v.properties ?? {});
  const requiredBy = variants.map((v) => new Set(v.required ?? []));
  const names = [...new Set(branches.flatMap((p) => Object.keys(p)))];
  const required = names.filter((name) =>
    requiredBy.every((set) => set.has(name)),
  );
  const discriminator = discriminatorOf(branches);
  const valueOf = (index: number) =>
    JSON.stringify(discriminator?.values[index]);

  /** One field's copies, by the branch that declares each. */
  type Copies = readonly {
    readonly index: number;
    readonly description: string | undefined;
    readonly shape: JSONSchemaObject;
    readonly nullable: boolean;
  }[];

  /** The field's description: the one its copies share, else each
   *  wording under the discriminator values whose branches use it. */
  const describe = (copies: Copies): string | undefined => {
    const byText = new Map<string, number[]>();
    for (const { index, description } of copies) {
      const text = description ?? '';
      byText.set(text, [...(byText.get(text) ?? []), index]);
    }
    const texts = [...byText.keys()].filter((text) => text !== '');
    if (copies.length === branches.length && texts.length <= 1) {
      return texts[0];
    }
    if (discriminator === undefined) return texts.join(' | ') || undefined;
    return [...byText]
      .map(([text, indexes]) => {
        const values = DISJUNCTION.format(indexes.map(valueOf));
        return `With ${discriminator.name} ${values}${text === '' ? '.' : `: ${text}`}`;
      })
      .join(' ');
  };

  const property = (name: string): JSONSchemaObject => {
    const copies: Copies = branches.flatMap((properties, index) =>
      properties[name] === undefined
        ? []
        : [{ index, ...splitField(properties[name]) }],
    );
    let value: JSONSchemaObject;
    let description: string | undefined;
    if (name === discriminator?.name) {
      // A literal discriminator may also be a number or a boolean.
      const type = copies
        .map(({ shape }) => shape.type)
        .find(Predicate.isString);
      value = {
        type: type ?? typeof discriminator.values[0],
        enum: discriminator.values,
      };
      description =
        copies
          .flatMap(({ index, description: text }) =>
            text === undefined ? [] : [`${valueOf(index)}: ${text}`],
          )
          .join(' | ') || undefined;
    } else {
      const shapes = [
        ...new Map(
          copies.map(({ shape }) => [JSON.stringify(shape), shape]),
        ).values(),
      ];
      value = shapes.length === 1 ? shapes[0] : { anyOf: shapes };
      description = describe(copies);
    }
    // Optional here (another branch lacks it), or nullable as declared.
    if (!required.includes(name) || copies.some((copy) => copy.nullable))
      value = nullable(value);
    return description === undefined ? value : { ...value, description };
  };

  const flat: JSONSchemaObject = {
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, property(name)])),
  };
  if (required.length > 0) flat.required = required;
  if (typeof schema.description === 'string') {
    flat.description = schema.description;
  }
  if (schema.$defs !== undefined) flat.$defs = schema.$defs;
  return flat;
}

/**
 * OpenAI and Gemini both reject `$schema` at the top level of function
 * parameter schemas. Effect Schema keeps the dialect outside the schema, but
 * a pre-built `parameters` document (an MCP server's) may carry the URI.
 * Strip it for any provider.
 */
function stripDollarSchema(schema: JSONSchemaObject): JSONSchemaObject {
  if (!('$schema' in schema)) return schema;
  const { $schema: _unused, ...rest } = schema;
  return rest;
}

/** Keywords whose value is data, never a schema to walk. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  'enum',
  'const',
  'default',
  'examples',
]);

/**
 * OpenAI rejects an array schema without an `items` schema, strict mode or
 * not (HTTP 400: `array schema missing items`), and takes neither
 * `prefixItems` nor the legacy array form of `items`. Effect Schema emits a
 * tuple (`view_range`) as `prefixItems` with `minItems`/`maxItems`, and
 * `Schema.Array(Schema.Unknown)` as a bare `{ type: 'array' }`. Every array
 * therefore names one `items` schema: a tuple's element schemas (one, or
 * `anyOf` the distinct ones) with its length as the bounds it does not
 * declare, and an untyped array `{}`. Dispatch still validates the call
 * against the tool's own schema.
 *
 * The same walk drops two things Effect Schema emits that no provider saw
 * before: `additionalProperties: true` on every struct (the JSON Schema
 * default, so dropping it changes nothing for a validator; the harness
 * never tells a model an object is closed) and the duplicate `null` member
 * of `Schema.optional(Schema.NullOr(S))`, which encodes both the absent and
 * the null case as `{ type: 'null' }`.
 */
function withArrayItems(node: JSONSchemaObject): JSONSchemaObject;
function withArrayItems(node: unknown): unknown;
function withArrayItems(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withArrayItems);
  if (!Predicate.isObject(node)) return node;
  const walkedValue = (key: string, value: unknown): unknown => {
    if (DATA_KEYWORDS.has(key)) return value;
    if (key === 'anyOf' && Array.isArray(value))
      return distinct(value.map(withArrayItems));
    return withArrayItems(value);
  };
  const walked = Object.fromEntries(
    Object.entries(node)
      .filter(
        ([key, value]) => key !== 'additionalProperties' || value !== true,
      )
      .map(([key, value]) => [key, walkedValue(key, value)]),
  );
  const { type, prefixItems, items, ...rest } = walked;
  if (![type].flat().includes('array')) return walked;
  // The legacy tuple form is `items: [...]`.
  const tuple = Array.isArray(items) ? items : prefixItems;
  if (!Array.isArray(tuple)) return { items: {}, ...walked };
  // A schema `items` beside `prefixItems` types the elements past the tuple.
  const tail = Predicate.isObject(items) ? [items] : [];
  const elements = distinct([...tuple, ...tail]);
  return {
    type,
    ...rest,
    items: elements.length > 1 ? { anyOf: elements } : (elements[0] ?? {}),
    // Declared bounds stand; a tuple without them is exactly its length.
    minItems: rest.minItems ?? tuple.length,
    ...(tail.length > 0 || rest.maxItems !== undefined
      ? {}
      : { maxItems: tuple.length }),
  };
}

/** The schemas of `nodes` with structural duplicates dropped, first kept. */
const distinct = (nodes: readonly unknown[]): unknown[] => [
  ...new Map(nodes.map((node) => [JSON.stringify(node), node])).values(),
];

/** A tool's input as JSON Schema, unflattened: its Effect Schema converted
 *  (its definitions, if any, attached as `$defs`, where the emitted `$ref`s
 *  point), else its pre-converted parameters. */
export const inputSchema = (
  definition: ToolDefinition,
): JsonSchema.JsonSchema | undefined => {
  if (definition.schema === undefined) return definition.parameters;
  const { schema, definitions } = Schema.toJsonSchemaDocument(
    definition.schema,
  );
  const root = withObjectRoot(definition, schema);
  return Object.keys(definitions).length === 0
    ? root
    : { ...root, $defs: definitions };
};

/**
 * Converts an Effect Schema to JSON Schema, or returns the pre-converted
 * parameters: top-level unions are flattened, a fieldless struct is an
 * empty object, every array names its `items`, and `$schema` is stripped so
 * the output passes every provider's schema validator.
 */
export function convertToolSchema(
  def: ToolDefinition,
): JSONSchemaObject | null {
  const schema: JSONSchemaObject | undefined = inputSchema(def);
  if (!schema) return null;
  return withArrayItems(stripDollarSchema(flattenTopLevelUnion(schema)));
}

/**
 * Every function-calling API takes only an object as a tool's parameters,
 * and Effect Schema emits a struct with no fields as `{ not: { type: 'null' } }`
 * (it decodes any value but null). A tool whose schema is a struct declared
 * an object, so its parameters are one, on the wire and in the script's
 * declarations alike; any other root stays as it is, for the provider to
 * reject by the tool's name.
 */
function withObjectRoot(
  def: ToolDefinition,
  schema: JSONSchemaObject,
): JSONSchemaObject {
  if (
    schema.type === 'object' ||
    def.schema === undefined ||
    !SchemaAST.isObjects(SchemaAST.toEncoded(def.schema.ast))
  )
    return schema;
  const { not: _not, ...rest } = schema;
  return { ...rest, type: 'object', properties: {} };
}
