/**
 * Spec drift: the OpenRouter wire shapes in `src/api/openrouterChatWire.ts`,
 * checked against the OpenAPI document OpenRouter publishes. It spends nothing
 * and needs no key, only the network. A failure lists each field or value
 * that moved, so the wire module changes before a turn meets the change.
 *
 * Inbound (a stream chunk), every field we read must exist, every field we
 * require must be required, and every value the spec allows for a field we
 * check must be one we accept. Outbound (the request), every field and value
 * we send must exist. A field the spec adds and we do not read is not drift.
 */

// Third-party imports
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports
import {
  ChatRequestSchema,
  ChatStreamChunkSchema,
} from '../src/api/openrouterChatWire.js';

type Node = { readonly [key: string]: any };

const SPEC_URL = 'https://openrouter.ai/openapi.json';
const DISCRIMINATORS = ['type', 'role'];

/** A spec node with its `$ref` followed and its `allOf` merged. */
function resolve(spec: Node, node: Node): Node {
  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace('#/components/schemas/', '');
    return resolve(spec, {
      ...spec.components.schemas[name],
      ...without(node, '$ref'),
    });
  }
  if (!Array.isArray(node.allOf)) return node;
  return node.allOf
    .map((part: Node) => resolve(spec, part))
    .reduce(
      (merged: Node, part: Node) => ({
        ...merged,
        ...part,
        properties: { ...merged.properties, ...part.properties },
        required: [...(merged.required ?? []), ...(part.required ?? [])],
      }),
      without(node, 'allOf'),
    );
}

function without(node: Node, key: string): Node {
  const { [key]: _, ...rest } = node;
  return rest;
}

const isNull = (node: Node) =>
  node.type === 'null' || (node.enum?.length === 1 && node.enum[0] === null);

/** The non-null alternatives of a node: its union members, or itself. */
function variants(spec: Node, node: Node): Node[] {
  const resolved = resolve(spec, node);
  const members = resolved.anyOf ?? resolved.oneOf;
  if (!Array.isArray(members)) return [resolved];
  return members
    .map((member: Node) => resolve(spec, member))
    .filter((member: Node) => !isNull(member))
    .flatMap((member: Node) => variants(spec, member));
}

/** The literal values a node admits, or undefined when it is not a literal set. */
function literals(nodes: Node[]): unknown[] | undefined {
  const values = nodes.flatMap((node): unknown[] => {
    if ('const' in node) return [node.const];
    return Array.isArray(node.enum) ? node.enum : [undefined];
  });
  return values.includes(undefined)
    ? undefined
    : values.filter((value) => value !== null);
}

function discriminator(nodes: Node[]): string | undefined {
  return DISCRIMINATORS.find((key) =>
    nodes.every(
      (node) => literals([node.properties?.[key] ?? {}])?.length === 1,
    ),
  );
}

const types = (nodes: Node[]) =>
  new Set(
    nodes.flatMap((node) =>
      [node.type ?? []]
        .flat()
        .map((type: string) => (type === 'integer' ? 'number' : type)),
    ),
  );

/** Every way `ours` disagrees with `theirs`, as one line each. */
function drift(
  spec: Node,
  ours: Node,
  theirs: Node,
  path: string,
  inbound: boolean,
): string[] {
  const mine = variants({}, ours);
  const spec_ = variants(spec, theirs);
  const ownValues = literals(mine);
  const specValues = literals(spec_);
  if (ownValues !== undefined && specValues !== undefined) {
    const missing = inbound
      ? specValues.filter((value) => !ownValues.includes(value))
      : ownValues.filter((value) => !specValues.includes(value));
    return missing.map((value) =>
      inbound
        ? `${path}: the spec allows ${JSON.stringify(value)}, which we refuse`
        : `${path}: we send ${JSON.stringify(value)}, which the spec does not list`,
    );
  }
  const key = mine.length > 1 ? discriminator(mine) : undefined;
  if (key !== undefined) {
    const tag = (node: Node) =>
      literals([resolve(spec, node.properties?.[key] ?? {})])?.[0];
    const theirsByTag = new Map(spec_.map((node) => [tag(node), node]));
    const mineByTag = new Map(mine.map((node) => [tag(node), node]));
    const problems = (inbound ? [...theirsByTag.keys()] : [...mineByTag.keys()])
      .filter((value) => !(inbound ? mineByTag : theirsByTag).has(value))
      .map((value) =>
        inbound
          ? `${path}: the spec has a ${key} ${JSON.stringify(value)} we refuse`
          : `${path}: we send a ${key} ${JSON.stringify(value)} the spec does not list`,
      );
    for (const [value, node] of mineByTag) {
      const match = theirsByTag.get(value);
      if (match !== undefined)
        problems.push(
          ...drift(
            spec,
            node,
            match,
            `${path}[${key}=${String(value)}]`,
            inbound,
          ),
        );
    }
    return problems;
  }
  const own = mine[0];
  if (own === undefined) return [];
  if (own.type === 'object' && own.properties !== undefined) {
    const objects = spec_.filter((node) => node.properties !== undefined);
    const properties: Node = Object.assign(
      {},
      ...objects.map((node) => node.properties),
    );
    const required = new Set(objects.flatMap((node) => node.required ?? []));
    const problems: string[] = [];
    for (const [field, schema] of Object.entries(own.properties as Node)) {
      const at = `${path}.${field}`;
      if (!(field in properties)) {
        problems.push(`${at}: the spec has no such field`);
        continue;
      }
      if (inbound && own.required?.includes(field) && !required.has(field))
        problems.push(`${at}: we require it; the spec makes it optional`);
      problems.push(...drift(spec, schema, properties[field], at, inbound));
    }
    return problems;
  }
  if (own.type === 'array') {
    const array = spec_.find((node) => node.items !== undefined);
    return array === undefined
      ? [`${path}: the spec has no array here`]
      : drift(spec, own.items, array.items, `${path}[]`, inbound);
  }
  const ownTypes = types(mine);
  const specTypes = types(spec_);
  if (ownTypes.size === 0 || specTypes.size === 0) return [];
  return [...ownTypes].some((type) => specTypes.has(type))
    ? []
    : [`${path}: we expect ${[...ownTypes]}, the spec says ${[...specTypes]}`];
}

describe('OpenRouter Chat wire against the published OpenAPI document', () => {
  const spec = fetch(SPEC_URL).then((response) => {
    if (!response.ok)
      throw new Error(`${SPEC_URL} answered HTTP ${response.status}`);
    return response.json() as Promise<Node>;
  });

  it.each([
    ['a stream chunk', 'ChatStreamChunk', ChatStreamChunkSchema, true],
    ['the request', 'ChatRequest', ChatRequestSchema, false],
  ] as const)('%s matches %s', async (_, component, schema, inbound) => {
    const document = await spec;
    const ours = Schema.toJsonSchemaDocument(schema).schema as Node;
    expect(
      drift(
        document,
        ours,
        document.components.schemas[component],
        component,
        inbound,
      ),
    ).toEqual([]);
  });
});
