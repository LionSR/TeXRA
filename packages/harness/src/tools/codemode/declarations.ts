/**
 * Tools as TypeScript, the way a `script` sees them: `name(args: T):
 * Promise<ToolOutput>` (or the type the tool declares it resolves to,
 * `scriptReturns`), with `T` rendered from the JSON Schema the tool's
 * Zod input converts to (`convertToolSchema` before the flattening a wire
 * declaration needs, so a discriminated union stays a union of its
 * branches, and a field with a default is an optional input). The short
 * form is the one the `script` description inlines: the description's first
 * sentence as a doc comment and no field descriptions. The full form is what
 * `describeTool` returns: the whole description, a doc comment per field.
 */
import { Predicate } from 'effect';
import { toJSONSchema } from 'zod';

import type { ToolDefinition } from '@shared/schemas';
import { TOOL_JSON_SCHEMA_OPTIONS } from '@shared/tools/toolJsonSchema';

type Schema = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const INDENT = '  ';

/** The description's first sentence: what the short form's doc comment says. */
export const firstSentence = (text: string | undefined): string => {
  const trimmed = (text ?? '').trim();
  const end = /[.!?](?=\s|$)|\n/.exec(trimmed);
  return end === null ? trimmed : trimmed.slice(0, end.index + 1).trim();
};

/** A tool's input as JSON Schema, unflattened. */
export const inputSchema = (definition: ToolDefinition): unknown =>
  definition.zodSchema === undefined
    ? definition.parameters
    : toJSONSchema(definition.zodSchema, TOOL_JSON_SCHEMA_OPTIONS);

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

/** A JSON Schema as a TypeScript type; `full` spreads objects one field per
 *  line, each under its description. */
function typeOf(
  schema: unknown,
  root: Schema,
  full: boolean,
  indent: string,
  resolving: ReadonlySet<string> = new Set(),
): string {
  if (!Predicate.isObject(schema))
    return schema === false ? 'never' : 'unknown';
  const recur = (inner: unknown, at = indent) =>
    typeOf(inner, root, full, at, resolving);
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    const target = ref.startsWith('#/')
      ? ref
          .slice(2)
          .split('/')
          .reduce<unknown>(
            (node, key) => (Predicate.isObject(node) ? node[key] : undefined),
            root,
          )
      : undefined;
    return target === undefined || resolving.has(ref)
      ? 'unknown'
      : typeOf(target, root, full, indent, new Set([...resolving, ref]));
  }
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return union(schema.enum.map((value) => JSON.stringify(value)));
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const spread =
      full &&
      variants.some(
        (variant) =>
          Predicate.isObject(variant) && Predicate.isObject(variant.properties),
      );
    if (!spread) return union(variants.map((variant) => recur(variant)));
    // One object branch per line, its description as its doc comment.
    return variants
      .map((variant) => {
        const doc =
          Predicate.isObject(variant) && typeof variant.description === 'string'
            ? docComment(variant.description, indent).join('\n') + '\n'
            : '';
        return `\n${doc}${indent}| ${recur(variant)}`;
      })
      .join('');
  }
  if (Array.isArray(schema.allOf))
    return schema.allOf.map((part) => recur(part)).join(' & ');
  if (Array.isArray(schema.type))
    return union(schema.type.map((type) => recur({ ...schema, type })));
  switch (schema.type) {
    case 'string':
    case 'boolean':
    case 'null':
      return schema.type;
    case 'number':
    case 'integer':
      return 'number';
    case 'array': {
      if (Array.isArray(schema.prefixItems))
        return `[${schema.prefixItems.map((item) => recur(item)).join(', ')}]`;
      const item = recur(schema.items);
      return /^[\w"]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
    }
  }
  if (schema.type !== 'object' && !Predicate.isObject(schema.properties))
    return 'unknown';
  const properties = Predicate.isObject(schema.properties)
    ? schema.properties
    : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const extra = schema.additionalProperties;
  const fields = Object.entries(properties).map(([name, property]) => {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    const head = `${key}${required.has(name) ? '' : '?'}: `;
    if (!full) return `${head}${recur(property)}`;
    const inner = `${indent}${INDENT}`;
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
      `${inner}${head}${recur(property, inner)};`,
    ].join('\n');
  });
  // A loose object's open index says nothing a script needs: only a typed
  // one, or a record with no named fields, is declared.
  if (
    fields.length === 0
      ? extra !== false
      : Predicate.isObject(extra) && Object.keys(extra).length > 0
  )
    fields.push(
      `${full ? `${indent}${INDENT}` : ''}[key: string]: ${recur(extra)}${full ? ';' : ''}`,
    );
  if (fields.length === 0) return '{}';
  return full
    ? `{\n${fields.join('\n')}\n${indent}}`
    : `{ ${fields.join('; ')} }`;
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
  const args = typeOf(root, root, full, indent);
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
  const first = typeOf(properties[positional], root, false, '');
  const member = IDENTIFIER.test(definition.name)
    ? `tools.${definition.name}`
    : `tools[${JSON.stringify(definition.name)}]`;
  const args = `Parameters<typeof ${member}>[0]`;
  return [
    ...docComment(definition.description ?? '', ''),
    `declare function ${definition.name}(${positional}: ${first}, opts?: Omit<${args}, ${JSON.stringify(positional)}>): ReturnType<typeof ${member}>;`,
  ].join('\n');
}
