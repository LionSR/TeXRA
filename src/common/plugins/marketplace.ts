// The marketplace files that list plugins, in the formats other agents
// publish: Claude Code's `.claude-plugin/marketplace.json` and Codex's
// `.agents/plugins/marketplace.json`. A source directory is one plugin when
// it holds a plugin manifest (`./pluginManifest`), else the plugins its
// marketplace lists.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - this module's neighbours
import {
  ComponentPathsSchema,
  containedPath,
  failPlugin,
  PLUGIN_MANIFEST_FILES,
  readJsonFile,
  readPluginManifests,
} from './pluginManifest';

const MARKETPLACE_FILES = [
  path.join('.claude-plugin', 'marketplace.json'),
  path.join('.agents', 'plugins', 'marketplace.json'),
] as const;

/**
 * A marketplace entry's `source`: a path relative to the marketplace root, or
 * an object whose `source` names the kind. v1 installs `local`, `github` and
 * `url` kinds; any other kind is refused by name when it is selected.
 */
const MarketplaceSourceSchema = z.union([
  z.string(),
  z.object({
    source: z.string(),
    path: z.string().optional(),
    repo: z.string().optional(),
    url: z.string().optional(),
    ref: z.string().optional(),
  }),
]);

const MarketplaceEntrySchema = z.object({
  name: z.string(),
  source: MarketplaceSourceSchema,
  description: z.string().optional(),
  version: z.string().optional(),
  skills: ComponentPathsSchema.optional(),
});
type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>;

const MarketplaceSchema = z.object({
  name: z.string(),
  metadata: z.object({ pluginRoot: z.string().optional() }).optional(),
  plugins: z.array(MarketplaceEntrySchema),
});

/** A plugin a source directory offers: in the directory, or fetched by git. */
export type PluginCandidate =
  | {
      readonly kind: 'dir';
      readonly dir: string;
      readonly entry?: MarketplaceEntry;
    }
  | { readonly kind: 'git'; readonly url: string; readonly ref?: string };

const localSourcePath = (source: { source: string; path?: string }) =>
  source.source === 'local' ? source.path : undefined;

function marketplaceCandidate(
  root: string,
  pluginRoot: string,
  entry: MarketplaceEntry,
) {
  return Effect.gen(function* () {
    const { source } = entry;
    const localPath =
      typeof source === 'string' ? source : localSourcePath(source);
    if (localPath !== undefined) {
      const dir = yield* containedPath(root, path.join(pluginRoot, localPath));
      if (dir === undefined) {
        return yield* failPlugin(
          `Marketplace plugin ${entry.name} points at "${localPath}", which does not exist.`,
        );
      }
      return { kind: 'dir', dir, entry } satisfies PluginCandidate;
    }
    if (
      typeof source !== 'string' &&
      source.source === 'github' &&
      source.repo
    ) {
      return {
        kind: 'git',
        url: `https://github.com/${source.repo}.git`,
        ref: source.ref,
      } satisfies PluginCandidate;
    }
    if (typeof source !== 'string' && source.source === 'url' && source.url) {
      return {
        kind: 'git',
        url: source.url,
        ref: source.ref,
      } satisfies PluginCandidate;
    }
    return yield* failPlugin(
      `Marketplace plugin ${entry.name} uses a "${typeof source === 'string' ? source : source.source}" source, which TeXRA cannot install yet. Supported: a relative path, "local", "github" and "url".`,
    );
  });
}

/**
 * The plugins a source directory offers. A plugin manifest makes the
 * directory one plugin; otherwise a marketplace lists them, narrowed to
 * `only` when names are given. A marketplace listing several plugins needs
 * that narrowing, so an install never pulls in more than the user named.
 */
export function readPluginCandidates(root: string, only: readonly string[]) {
  return Effect.gen(function* () {
    if ((yield* readPluginManifests(root)).length > 0) {
      if (only.length > 0) {
        return yield* failPlugin(
          `${root} is a single plugin, not a marketplace; drop --plugin.`,
        );
      }
      return [{ kind: 'dir', dir: root }] satisfies PluginCandidate[];
    }
    for (const file of MARKETPLACE_FILES) {
      const marketplace = yield* readJsonFile(
        path.join(root, file),
        MarketplaceSchema,
      );
      if (!marketplace) continue;
      const names = marketplace.plugins.map((entry) => entry.name);
      const unknown = only.filter((name) => !names.includes(name));
      if (unknown.length > 0) {
        return yield* failPlugin(
          `Marketplace ${marketplace.name} has no plugin named ${unknown.join(', ')}. It lists: ${names.join(', ')}.`,
        );
      }
      if (only.length === 0 && names.length > 1) {
        return yield* failPlugin(
          `Marketplace ${marketplace.name} lists ${names.length} plugins (${names.join(', ')}). Choose with --plugin <name>.`,
        );
      }
      const selected = marketplace.plugins.filter(
        (entry) => only.length === 0 || only.includes(entry.name),
      );
      return yield* Effect.forEach(selected, (entry) =>
        marketplaceCandidate(
          root,
          marketplace.metadata?.pluginRoot ?? '.',
          entry,
        ),
      );
    }
    return yield* failPlugin(
      `No plugin found in ${root}: expected ${[...PLUGIN_MANIFEST_FILES, ...MARKETPLACE_FILES].join(', ')}.`,
    );
  });
}
