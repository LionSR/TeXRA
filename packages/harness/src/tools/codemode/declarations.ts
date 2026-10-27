/**
 * Tools as TypeScript, the way a `script` sees them: `name(args: T):
 * Promise<ToolOutput>` (or the type the tool declares it resolves to,
 * `scriptReturns`), with `T` rendered from the JSON Schema the tool's
 * input schema converts to (`convertToolSchema` before the flattening a wire
 * declaration needs, so a discriminated union stays a union of its
 * branches, and a field with a default is an optional input). The short
 * form is the one the `script` description inlines: the description's first
 * sentence as a doc comment and no field descriptions. The full form is what
 * `describeTool` returns: the whole description, a doc comment per field.
 */
import { Predicate } from 'effect';

import { inputSchema } from '@agent/core/tools/toolSchema';
import type { ToolDefinition } from '@shared/schemas';

type Schema = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const INDENT = '  ';

/** The description's first sentence: what the short form's doc comment says. */
export const firstSentence = (text: string | undefined): string => {
  const trimmed = (text ?? '').trim();
  const end = /[.!?](?=\s|$)|\n/.exec(trimmed);
  return end === null ? trimmed : trimmed.slice(0, end.index + 1).trim();
};

const docComment = (text: string, indent: string): string[] => {
  const lines = text.trim().replaceAll('*/', '*\\/').split(/\r?\n/);
  if (lines[0] === '') return [];
  return lines.length === 1
    ? [`${indent}/** ${lines[0]} */`]
    : [
        `${indent}/**`,
        ...lines.map((line) => `${indent} *${line === '' ? '' : ` ${line}`}`),
        `${indent} */`,
      ];
};

const union = (types: readonly string[]): string => {
  const unique = [...new Set(types)];
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 0 ? 'never' : unique.join(' | ');
};

/**
 * What rendering a schema carries into its parts: the root its `$ref`s
 * resolve against, the form (`full` spreads objects one field per line, each
 * under its description), the indent of the current line, and the refs being
 * expanded, so a recursive ref renders as `unknown`.
 */
interface Rendering {
  readonly root: Schema;
  readonly full: boolean;
  readonly indent: string;
  readonly resolving: ReadonlySet<string>;
}

/** A JSON Schema as a TypeScript type. */
function typeOf(schema: unknown, at: Rendering): string {
  if (!Predicate.isObject(schema))
    return schema === false ? 'never' : 'unknown';
  if (typeof schema.$ref === 'string') return refType(schema.$ref, at);
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return union(schema.enum.map((value) => JSON.stringify(value)));
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return variantsType(variants, at);
  if (Array.isArray(schema.allOf))
    return schema.allOf.map((part) => typeOf(part, at)).join(' & ');
  if (Array.isArray(schema.type))
    return union(schema.type.map((type) => typeOf({ ...schema, type }, at)));
  switch (schema.type) {
    case 'string':
    case 'boolean':
    case 'null':
      return schema.type;
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
      return arrayType(schema, at);
  }
  if (schema.type !== 'object' && !Predicate.isObject(schema.properties))
    return 'unknown';
  return objectType(schema, at);
}

/** A `#/...` ref into the root, expanded unless it is already being expanded. */
function refType(ref: string, at: Rendering): string {
  const target = ref.startsWith('#/')
    ? ref
        .slice(2)
        .split('/')
        .reduce<unknown>(
          (node, key) => (Predicate.isObject(node) ? node[key] : undefined),
          at.root,
        )
    : undefined;
  return target === undefined || at.resolving.has(ref)
    ? 'unknown'
    : typeOf(target, { ...at, resolving: new Set([...at.resolving, ref]) });
}

/** `anyOf`/`oneOf` as a union; in the full form, a union with an object
 *  branch puts one branch per line, its description as its doc comment. */
function variantsType(variants: readonly unknown[], at: Rendering): string {
  const spread =
    at.full &&
    variants.some(
      (variant) =>
        Predicate.isObject(variant) && Predicate.isObject(variant.properties),
    );
  if (!spread) return union(variants.map((variant) => typeOf(variant, at)));
  return variants
    .map((variant) => {
      const doc =
        Predicate.isObject(variant) && typeof variant.description === 'string'
          ? docComment(variant.description, at.indent).join('\n') + '\n'
          : '';
      return `\n${doc}${at.indent}| ${typeOf(variant, at)}`;
    })
    .join('');
}

/** An array: a tuple of its `prefixItems`, or a list of its `items`. */
function arrayType(schema: Schema, at: Rendering): string {
  if (Array.isArray(schema.prefixItems))
    return `[${schema.prefixItems.map((item) => typeOf(item, at)).join(', ')}]`;
  const item = typeOf(schema.items, at);
  return /^[\w"]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
}

/** An object: its named fields, and an index signature when it declares a
 *  typed one or names no field. */
function objectType(schema: Schema, at: Rendering): string {
  const { full, indent } = at;
  const properties = Predicate.isObject(schema.properties)
    ? schema.properties
    : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const extra = schema.additionalProperties;
  const fields = Object.entries(properties).map(([name, property]) =>
    fieldOf(name, property, required.has(name), at),
  );
  // A loose object's open index says nothing a script needs: only a typed
  // one, or a record with no named fields, is declared.
  if (
    fields.length === 0
      ? extra !== false
      : Predicate.isObject(extra) && Object.keys(extra).length > 0
  )
    fields.push(
      `${full ? `${indent}${INDENT}` : ''}[key: string]: ${typeOf(extra, at)}${full ? ';' : ''}`,
    );
  if (fields.length === 0) return '{}';
  return full
    ? `{\n${fields.join('\n')}\n${indent}}`
    : `{ ${fields.join('; ')} }`;
}

/** One field of an object; the full form puts it on its own line under its
 *  description and default. */
function fieldOf(
  name: string,
  property: unknown,
  required: boolean,
  at: Rendering,
): string {
  const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
  const head = `${key}${required ? '' : '?'}: `;
  if (!at.full) return `${head}${typeOf(property, at)}`;
  const inner = `${at.indent}${INDENT}`;
  const notes = Predicate.isObject(property)
    ? [
        typeof property.description === 'string' ? property.description : '',
        'default' in property
          ? `Default: ${JSON.stringify(property.default)}.`
          : '',
      ].filter((note) => note !== '')
    : [];
  return [
    ...docComment(notes.join(' '), inner),
    `${inner}${head}${typeOf(property, { ...at, indent: inner })};`,
  ].join('\n');
}

/**
 * One tool as a member of `tools`. The short form leads with the
 * description's first sentence; the full form with all of it, and documents
 * each field.
 */
export function declarationOf(
  definition: ToolDefinition,
  full: boolean,
  indent = '',
): string {
  const schema = inputSchema(definition);
  const root = Predicate.isObject(schema) ? schema : {};
  const args = typeOf(root, { root, full, indent, resolving: new Set() });
  const name = IDENTIFIER.test(definition.name)
    ? definition.name
    : JSON.stringify(definition.name);
  const description = full
    ? (definition.description ?? '')
    : firstSentence(definition.description);
  return [
    ...docComment(description, indent),
    `${indent}${name}(args: ${args}): Promise<${definition.scriptReturns ?? 'ToolOutput'}>;`,
  ].join('\n');
}

/**
 * A tool that is also a script global (`ITool.scriptGlobal`), as a function:
 * its `positional` field first, the rest of its arguments second, under the
 * tool's whole description, which names what it rejects with.
 */
export function globalDeclarationOf(
  definition: ToolDefinition,
  positional: string,
): string {
  const schema = inputSchema(definition);
  const root = Predicate.isObject(schema) ? schema : {};
  const properties = Predicate.isObject(root.properties) ? root.properties : {};
  const first = typeOf(properties[positional], {
    root,
    full: false,
    indent: '',
    resolving: new Set(),
  });
  const member = IDENTIFIER.test(definition.name)
    ? `tools.${definition.name}`
    : `tools[${JSON.stringify(definition.name)}]`;
  const args = `Parameters<typeof ${member}>[0]`;
  return [
    ...docComment(definition.description ?? '', ''),
    `declare function ${definition.name}(${positional}: ${first}, opts?: Omit<${args}, ${JSON.stringify(positional)}>): ReturnType<typeof ${member}>;`,
  ].join('\n');
}
