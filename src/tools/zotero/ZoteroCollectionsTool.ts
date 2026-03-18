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
import { defineTool } from '@tools/core/define';

// Local imports - zotero
import {
  callBetterBibTeX,
  getZoteroPort,
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

  // Link children to parents
  for (const c of collections) {
    const node = nodeMap.get(c.key)!;
    if (c.parentCollection && typeof c.parentCollection === 'string') {
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
 */
function formatTree(nodes: CollectionNode[], indent: number = 0): string[] {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = indent === 0 ? '' : isLast ? '└── ' : '├── ';
    const childPrefix = indent === 0 ? '' : isLast ? '    ' : '│   ';

    lines.push(`${prefix}${connector}${node.name}/ [${node.key}]`);

    if (node.children.length > 0) {
      const childLines = formatTree(
        node.children,
        0, // reset indent — we handle prefix manually
      );
      for (const line of childLines) {
        lines.push(`${prefix}${childPrefix}${line}`);
      }
    }
  }

  return lines;
}

/**
 * Filter tree nodes by query, keeping ancestors of matching nodes.
 */
function filterTree(
  nodes: CollectionNode[],
  query: string,
): CollectionNode[] {
  const lowerQuery = query.toLowerCase();

  function matches(node: CollectionNode): CollectionNode | null {
    const nameMatches = node.name.toLowerCase().includes(lowerQuery);
    const filteredChildren = node.children
      .map((child) => matches(child))
      .filter((c): c is CollectionNode => c !== null);

    if (nameMatches || filteredChildren.length > 0) {
      return { key: node.key, name: node.name, children: filteredChildren };
    }
    return null;
  }

  return nodes
    .map((n) => matches(n))
    .filter((n): n is CollectionNode => n !== null);
}

export class ZoteroCollectionsTool extends defineTool({
  name: 'zotero_collections',
  description:
    'List Zotero collections with their keys. ' +
    'Use this to discover collection keys before adding items with zotero_add. ' +
    'Optionally filter by name or library. ' +
    'Requires Better BibTeX plugin to be installed in Zotero.',
  schema: ZoteroCollectionsInputSchema,
}) {
  protected async execute({ query, library }: ZoteroCollectionsInput) {
    const port = getZoteroPort();

    const libraries = await callBetterBibTeX<BbtLibrary[]>(
      'user.groups',
      [true],
      port,
    );

    if (!Array.isArray(libraries) || libraries.length === 0) {
      return {
        summary: 'No libraries found in Zotero.',
        output: 'No libraries found. Is Zotero running with items in your library?',
      };
    }

    // Filter by library name if specified
    const targetLibraries = library
      ? libraries.filter(
          (lib) => lib.name.toLowerCase() === library.toLowerCase(),
        )
      : libraries;

    if (targetLibraries.length === 0) {
      const available = libraries.map((lib) => lib.name).join(', ');
      return {
        summary: `Library "${library}" not found.`,
        output: `Library "${library}" not found. Available libraries: ${available}`,
      };
    }

    const outputParts: string[] = [];
    let totalCollections = 0;

    for (const lib of targetLibraries) {
      const collections = lib.collections ?? [];
      if (collections.length === 0) continue;

      let tree = buildTree(collections);

      if (query) {
        tree = filterTree(tree, query);
      }

      if (tree.length === 0) continue;

      totalCollections += collections.length;
      outputParts.push(`Library: ${lib.name}`);
      outputParts.push(...formatTree(tree, 1));
    }

    if (outputParts.length === 0) {
      const context = query ? ` matching "${query}"` : '';
      return {
        summary: `No collections found${context}.`,
        output: `No collections found${context}.`,
      };
    }

    const context = query ? ` matching "${query}"` : '';
    return {
      summary: `Found ${totalCollections} collection${totalCollections === 1 ? '' : 's'}${context} across ${targetLibraries.length} ${targetLibraries.length === 1 ? 'library' : 'libraries'}.`,
      output: outputParts.join('\n'),
    };
  }
}
