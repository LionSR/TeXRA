/**
 * List Zotero collections via Better BibTeX JSON-RPC API.
 *
 * Returns the collection tree with keys so the agent can pass
 * a collection key to `zotero_add`. Does one thing: queries
 * the collection hierarchy. No paper searching, no side effects.
 *
 * Requires the Better BibTeX plugin to be installed in Zotero.
 * See: https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 */

// Third-party imports
import { z } from 'zod';

// Local imports - core
import type { ToolResult } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { filterNotNull } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - zotero
import {
  callBetterBibTeX,
  getZoteroPort,
  BbtLibrarySchema,
  type BbtCollection,
  type BbtLibrary,
} from './bbtClient';

const ZoteroCollectionsInputSchema = z.strictObject({
  query: z
    .string()
    .describe(
      'Optional name to filter collections (case-insensitive partial match).',
    )
    .nullish(),
  library: z
    .string()
    .describe(
      'Optional library name to list collections from. Omit for all libraries.',
    )
    .nullish(),
});

type ZoteroCollectionsInput = z.infer<typeof ZoteroCollectionsInputSchema>;

/**
 * Build a tree from a flat list of collections using parentCollection references.
 * Returns root-level collections with children nested.
 */
interface CollectionNode {
  key: string;
  name: string;
  children: CollectionNode[];
}

function buildTree(collections: BbtCollection[]): CollectionNode[] {
  const nodeMap = new Map<string, CollectionNode>();
  const roots: CollectionNode[] = [];

  // Create all nodes
  for (const c of collections) {
    nodeMap.set(c.key, { key: c.key, name: c.name, children: [] });
  }

  // Link children to parents. Safe: this loop walks the same `collections`
  // array the first loop just used to key every node by `c.key`, so the
  // lookup below can never miss.
  for (const c of collections) {
    const node = nodeMap.get(c.key)!;
    if (typeof c.parentCollection === 'string') {
      const parent = nodeMap.get(c.parentCollection);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return roots;
}

/**
 * Format a collection tree as indented text with keys.
 * Uses prefix-passing to correctly indent arbitrarily deep trees.
 */
function formatTree(
  nodes: CollectionNode[],
  parentPrefix: string = '',
): string[] {
  const lines: string[] = [];

  for (const [i, node] of nodes.entries()) {
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childContinuation = isLast ? '    ' : '│   ';

    lines.push(`${parentPrefix}${connector}${node.name}/ [${node.key}]`);

    if (node.children.length > 0) {
      lines.push(
        ...formatTree(node.children, `${parentPrefix}${childContinuation}`),
      );
    }
  }

  return lines;
}

/**
 * Result of filtering a tree: the pruned tree plus how many nodes
 * actually matched by name (excluding ancestors kept only for context).
 */
interface FilterResult {
  tree: CollectionNode[];
  matchCount: number;
}

/**
 * Filter tree nodes by query, keeping ancestors of matching nodes.
 * Returns both the filtered tree and the count of actual name-matches.
 */
function filterTree(nodes: CollectionNode[], query: string): FilterResult {
  const lowerQuery = query.toLowerCase();
  let matchCount = 0;

  function visit(node: CollectionNode): CollectionNode | null {
    const nameMatches = node.name.toLowerCase().includes(lowerQuery);
    const filteredChildren = node.children
      .map((child) => visit(child))
      .filter(filterNotNull);

    if (nameMatches) matchCount++;

    if (nameMatches || filteredChildren.length > 0) {
      return { key: node.key, name: node.name, children: filteredChildren };
    }
    return null;
  }

  const tree = nodes.map((n) => visit(n)).filter(filterNotNull);

  return { tree, matchCount };
}

export class ZoteroCollectionsTool extends defineTool({
  name: 'zotero_collections',
  parallelSafe: true,
  description:
    'List Zotero collections (folders) with their keys. ' +
    'Use this to discover collection keys before adding items with zotero_add. ' +
    'To see which collections a paper belongs to, use zotero_search with include_collections instead. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroCollectionsInputSchema,
}) {
  protected async execute({
    query,
    library,
  }: ZoteroCollectionsInput): Promise<ToolResult> {
    const port = getZoteroPort();

    const libraries = await callBetterBibTeX(
      'user.groups',
      [true],
      port,
      z.array(BbtLibrarySchema),
    );

    if (libraries.length === 0) {
      return executed(
        'No libraries found. Is Zotero running with items in your library?',
        'No libraries found in Zotero.',
      );
    }

    // Filter by library name if specified
    const normalizedLibrary = library?.toLowerCase();
    const targetLibraries = normalizedLibrary
      ? libraries.filter((lib) => lib.name.toLowerCase() === normalizedLibrary)
      : libraries;

    if (targetLibraries.length === 0) {
      const available = libraries.map((lib) => lib.name).join(', ');
      return executed(
        `Library "${library}" not found. Available libraries: ${available}`,
        `Library "${library}" not found.`,
      );
    }

    const outputParts: string[] = [];
    let totalCollections = 0;
    let librariesWithResults = 0;

    for (const lib of targetLibraries) {
      const collections = lib.collections ?? [];
      if (collections.length === 0) continue;

      const fullTree = buildTree(collections);

      const displayTree = query ? filterTree(fullTree, query) : null;
      const tree = displayTree?.tree ?? fullTree;
      if (tree.length === 0) continue;

      totalCollections += displayTree?.matchCount ?? collections.length;
      librariesWithResults++;
      outputParts.push(`Library: ${lib.name}`);
      outputParts.push(...formatTree(tree));
    }

    const context = query ? ` matching "${query}"` : '';
    if (outputParts.length === 0) {
      return executed(
        `No collections found${context}.`,
        `No collections found${context}.`,
      );
    }

    return executed(
      outputParts.join('\n'),
      `Found ${formatResultCount(totalCollections, 'collection')}${context} across ${formatResultCount(librariesWithResults, 'library', 'libraries')}.`,
    );
  }
}
