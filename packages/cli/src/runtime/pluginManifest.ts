// Reads the plugin formats other agents already publish: the Claude Code
// plugin manifest (`.claude-plugin/plugin.json`), the Codex plugin manifest
// (`.codex-plugin/plugin.json`), and the marketplace files that list plugins
// (`.claude-plugin/marketplace.json`, Codex's `.agents/plugins/marketplace.json`).
// TeXRA defines no manifest of its own. Each file is validated with Zod here,
// at the boundary; fields TeXRA does not read are stripped.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Data, Effect } from 'effect';
import { z } from 'zod';

import { isFileNotFoundError } from '@common/errors';
import { SkillNameSchema } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** A plugin that cannot be read or installed; the message is for the user. */
export class PluginError extends Data.TaggedError('PluginError')<{
  readonly message: string;
}> {}

const fail = (message: string) => Effect.fail(new PluginError({ message }));

/** A component path field: one relative path or several. */
const ComponentPathsSchema = z.union([z.string(), z.array(z.string())]);

/**
 * The manifest fields TeXRA reads. The Claude Code and Codex manifests agree
 * on these, so one schema reads both. The component fields after `skills`
 * are read only to report them as not loaded.
 */
const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  skills: ComponentPathsSchema.optional(),
  commands: z.unknown().optional(),
  agents: z.unknown().optional(),
  hooks: z.unknown().optional(),
  mcpServers: z.unknown().optional(),
  lspServers: z.unknown().optional(),
  outputStyles: z.unknown().optional(),
  apps: z.unknown().optional(),
});
type PluginManifest = z.infer<typeof PluginManifestSchema>;

const PLUGIN_MANIFEST_FILES = [
  path.join('.claude-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
] as const;

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

/**
 * Components v1 does not load, with the manifest fields and conventional
 * files that reveal each. They are reported, never read or run.
 */
const DEFERRED_COMPONENTS = [
  { label: 'mcp', field: 'mcpServers', files: ['.mcp.json'] },
  { label: 'hooks', field: 'hooks', files: ['hooks'] },
  { label: 'commands', field: 'commands', files: ['commands'] },
  { label: 'agents', field: 'agents', files: ['agents'] },
  { label: 'lsp', field: 'lspServers', files: ['.lsp.json'] },
  { label: 'output styles', field: 'outputStyles', files: ['output-styles'] },
  { label: 'apps', field: 'apps', files: ['.app.json'] },
] as const;

/** The deferred component labels, for help text and docs. */
export const DEFERRED_COMPONENT_LABELS = DEFERRED_COMPONENTS.map(
  (component) => component.label,
);

/** Whether `relative` (from `path.relative`) climbs out of its base. */
const escapes = (relative: string) =>
  relative === '..' ||
  relative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relative);

const pathExists = (target: string) =>
  Effect.tryPromise({ try: () => fs.stat(target), catch: ensureError }).pipe(
    Effect.as(true),
    Effect.catchIf(isFileNotFoundError, () => Effect.succeed(false)),
    Effect.mapError((error) => new PluginError({ message: error.message })),
  );

/** Read and validate one JSON file, or `undefined` when it is absent. */
function readJsonFile<T>(file: string, schema: z.ZodType<T>) {
  return Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => fs.readFile(file, 'utf8'),
      catch: ensureError,
    }).pipe(
      Effect.catchIf(isFileNotFoundError, () => Effect.succeed(undefined)),
      Effect.mapError((error) => new PluginError({ message: error.message })),
    );
    if (text === undefined) return undefined;
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) =>
        new PluginError({
          message: `${file} is not valid JSON: ${toErrorMessage(error)}`,
        }),
    });
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return yield* fail(
        `${file} does not match the expected shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  });
}

/**
 * Resolve a path a plugin declares against the directory it is relative to,
 * refusing any that could leave it: absolute paths, `..` segments that climb
 * out, and symlinks whose target lies outside.
 */
function containedPath(root: string, declared: string) {
  return Effect.gen(function* () {
    const resolved = path.resolve(root, declared);
    const relative = path.relative(root, resolved);
    if (path.isAbsolute(declared) || escapes(relative)) {
      return yield* fail(
        `Plugin path "${declared}" points outside the plugin directory ${root}.`,
      );
    }
    if (!(yield* pathExists(resolved))) return undefined;
    const [realRoot, realResolved] = yield* Effect.tryPromise({
      try: () => Promise.all([fs.realpath(root), fs.realpath(resolved)]),
      catch: (error) => new PluginError({ message: toErrorMessage(error) }),
    });
    const realRelative = path.relative(realRoot, realResolved);
    if (escapes(realRelative)) {
      return yield* fail(
        `Plugin path "${declared}" resolves through a symlink to ${realResolved}, outside the plugin directory ${root}.`,
      );
    }
    return resolved;
  });
}

const toList = (paths: string | readonly string[] | undefined) =>
  paths === undefined ? [] : [paths].flat();

/** What stands in for a missing manifest: a name and skill paths. */
type PluginFallback = Pick<
  PluginManifest,
  'name' | 'version' | 'description' | 'skills'
>;

/** One plugin read from its directory, before anything is recorded. */
interface ResolvedPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Skill roots relative to the plugin directory. */
  readonly skills: readonly string[];
  /** Deferred component labels the plugin contains. */
  readonly ignored: readonly string[];
}

/** The plugin manifests present in `dir`, Claude Code's first. */
function readPluginManifests(dir: string) {
  return Effect.forEach(PLUGIN_MANIFEST_FILES, (file) =>
    readJsonFile(path.join(dir, file), PluginManifestSchema),
  ).pipe(
    Effect.map((found) =>
      found.filter((manifest): manifest is PluginManifest => !!manifest),
    ),
  );
}

/**
 * Read the plugin in `dir`. Its skill roots are the conventional `skills/`
 * directory when present plus every `skills` path either manifest declares,
 * deduplicated. `fallback` stands in for a manifest when the plugin directory
 * has none: the marketplace entry, as a non-strict Claude Code marketplace
 * allows, or on a reread the plugin's own record.
 */
export function readPlugin(dir: string, fallback?: PluginFallback) {
  return Effect.gen(function* () {
    const found = yield* readPluginManifests(dir);
    const manifests: PluginFallback[] = [...found];
    if (manifests.length === 0 && fallback) manifests.push(fallback);
    const primary = manifests[0];
    if (!primary) {
      return yield* fail(
        `No plugin manifest in ${dir}: expected ${PLUGIN_MANIFEST_FILES.join(' or ')}.`,
      );
    }
    const name = SkillNameSchema.safeParse(primary.name);
    if (!name.success) {
      return yield* fail(
        `Plugin name "${primary.name}" is not usable: ${name.error.issues[0]?.message ?? 'invalid name'}.`,
      );
    }
    const declared = [
      'skills',
      ...manifests.flatMap((source) => toList(source.skills)),
    ];
    const skills = new Set<string>();
    for (const [index, candidate] of declared.entries()) {
      const resolved = yield* containedPath(dir, candidate);
      if (resolved === undefined) {
        // The conventional directory is optional; a declared one is not.
        if (index === 0) continue;
        return yield* fail(
          `Plugin ${name.data} declares skills at "${candidate}", which does not exist.`,
        );
      }
      skills.add(path.relative(dir, resolved) || '.');
    }
    const ignored: string[] = [];
    for (const component of DEFERRED_COMPONENTS) {
      const declaredField = found.some(
        (manifest) => manifest[component.field] !== undefined,
      );
      const present =
        declaredField ||
        (yield* Effect.forEach(component.files, (file) =>
          pathExists(path.join(dir, file)),
        )).some(Boolean);
      if (present) ignored.push(component.label);
    }
    return {
      name: name.data,
      version: primary.version,
      description: primary.description,
      skills: [...skills],
      ignored,
    } satisfies ResolvedPlugin;
  });
}

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
        return yield* fail(
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
    return yield* fail(
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
        return yield* fail(
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
        return yield* fail(
          `Marketplace ${marketplace.name} has no plugin named ${unknown.join(', ')}. It lists: ${names.join(', ')}.`,
        );
      }
      if (only.length === 0 && names.length > 1) {
        return yield* fail(
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
    return yield* fail(
      `No plugin found in ${root}: expected ${[...PLUGIN_MANIFEST_FILES, ...MARKETPLACE_FILES].join(', ')}.`,
    );
  });
}

/** Count the skill directories (`<name>/SKILL.md`) under one skill root. */
export function countSkills(root: string) {
  return Effect.tryPromise({
    try: () => fs.readdir(root, { withFileTypes: true }),
    catch: ensureError,
  }).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(entries, (entry) =>
        entry.isDirectory() || entry.isSymbolicLink()
          ? pathExists(path.join(root, entry.name, 'SKILL.md'))
          : Effect.succeed(false),
      ),
    ),
    Effect.map((found) => found.filter(Boolean).length),
    Effect.mapError(
      (error) => new PluginError({ message: toErrorMessage(error) }),
    ),
  );
}
