/**
 * What a script's `searchTools` and `describeTool` answer, from the tools
 * the step that offered the `script` call pinned, passed in as data: never
 * the live catalog. The ranker is Okapi BM25 over one run's catalog held in
 * memory, not SQLite FTS5: nothing here is stored, and FTS5's `unicode61`
 * tokenizer does not split `inputFiles` or `read_file` the way a tool name
 * needs.
 */
import type { ToolDefinition } from '@shared/schemas';
import { isObject } from '@utils/core';

import { declarationOf, firstSentence, inputSchema } from './declarations';

/** A tool a script may call, with the plugin (or MCP server) it comes from. */
interface CatalogTool {
  readonly definition: ToolDefinition;
  readonly plugin: string;
}

const STOP_WORDS = new Set(
  'a an and are as at be by for from in is it of on or that the this to with'.split(
    ' ',
  ),
);

/** A plural folded to its singular: `entries` to `entry`, `files` to `file`. */
const singular = (term: string): string => {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss'))
    return term.slice(0, -1);
  return term;
};

/** Lowercase terms, split at camelCase humps and every non-alphanumeric
 *  (`read_file`, `mcp__server__tool`), stop words dropped, plurals folded. */
const tokenize = (text: string): string[] =>
  text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term !== '' && !STOP_WORDS.has(term))
    .map(singular);

/** Property names and descriptions, through nested objects and unions. */
const schemaText = (schema: unknown): string[] => {
  if (!isObject(schema)) return [];
  return [
    ...(typeof schema.description === 'string' ? [schema.description] : []),
    ...Object.entries(
      isObject(schema.properties) ? schema.properties : {},
    ).flatMap(([name, property]) => [name, ...schemaText(property)]),
    ...schemaText(schema.items),
    ...[schema.anyOf, schema.oneOf, schema.allOf].flatMap((variants) =>
      Array.isArray(variants) ? variants.flatMap(schemaText) : [],
    ),
  ];
};

/** The tools of `catalog` that match `query`, best first; ties keep catalog
 *  order. BM25 with k1 = 1.2, b = 0.75. */
export function searchTools(
  catalog: readonly CatalogTool[],
  query: string,
  limit: number,
): { readonly name: string; readonly line: string }[] {
  const terms = [...new Set(tokenize(query))];
  const documents = catalog.map(({ definition, plugin }) => {
    const counts = new Map<string, number>();
    const text = [
      definition.name,
      definition.description ?? '',
      plugin,
      ...schemaText(inputSchema(definition)),
    ].join(' ');
    let length = 0;
    for (const term of tokenize(text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      length += 1;
    }
    return { definition, counts, length };
  });
  const average =
    documents.reduce((sum, { length }) => sum + length, 0) / documents.length ||
    1;
  const idf = new Map(
    terms.map((term) => {
      const n = documents.filter(({ counts }) => counts.has(term)).length;
      return [
        term,
        Math.log(1 + (documents.length - n + 0.5) / (n + 0.5)),
      ] as const;
    }),
  );
  return documents
    .map(({ definition, counts, length }) => ({
      definition,
      score: terms.reduce((score, term) => {
        const count = counts.get(term) ?? 0;
        const norm = 1.2 * (0.25 + (0.75 * length) / average);
        return score + (idf.get(term) ?? 0) * ((count * 2.2) / (count + norm));
      }, 0),
    }))
    .filter(({ score }) => score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ definition }) => ({
      name: definition.name,
      line: firstSentence(definition.description),
    }));
}

/** The full declaration of the tool named `name`, or null when the step
 *  offers none by that name. */
export const describeTool = (
  catalog: readonly CatalogTool[],
  name: string,
): string | null => {
  const tool = catalog.find(({ definition }) => definition.name === name);
  return tool === undefined ? null : declarationOf(tool.definition, true);
};
