// Reads the plugin formats other agents already publish: the Claude Code
// plugin manifest (`.claude-plugin/plugin.json`) and the Codex plugin
// manifest (`.codex-plugin/plugin.json`), with the conventional component
// locations beside them (`skills/`, `commands/`, `agents/`, `.mcp.json`).
// TeXRA defines no manifest of its own. Each file is validated with Zod here,
// at the boundary; fields TeXRA does not read are stripped. The marketplace
// files that list plugins are read by `./marketplace`.

// Node imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Data, Effect } from 'effect';
import { z } from 'zod';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';
import { SkillNameSchema } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - this module's neighbours
import {
  parseMcpServers,
  ServerNameSchema,
  type McpServerConfig,
} from './mcpServers';

/** A plugin that cannot be read or installed; the message is for the user. */
export class PluginError extends Data.TaggedError('PluginError')<{
  readonly message: string;
}> {}

/** What the user asked for cannot be done as asked: an unknown or taken
 *  name, or a marketplace that needs the plugin named. */
export class PluginRequestError extends Data.TaggedError('PluginRequestError')<{
  readonly message: string;
}> {}

export const failPlugin = (message: string) =>
  Effect.fail(new PluginError({ message }));

/** A component path field: one relative path or several. */
export const ComponentPathsSchema = z.union([z.string(), z.array(z.string())]);

/**
 * The manifest fields TeXRA reads. The Claude Code and Codex manifests agree
 * on these, so one schema reads both. `mcpServers` is a path, several, or
 * the servers inline; the fields after it are read only to classify them.
 */
const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  skills: ComponentPathsSchema.optional(),
  commands: ComponentPathsSchema.optional(),
  agents: ComponentPathsSchema.optional(),
  mcpServers: z
    .union([ComponentPathsSchema, z.record(z.string(), z.unknown())])
    .optional(),
  hooks: z.unknown().optional(),
  lspServers: z.unknown().optional(),
  outputStyles: z.unknown().optional(),
  apps: z.unknown().optional(),
});
type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PLUGIN_MANIFEST_FILES = [
  path.join('.claude-plugin', 'plugin.json'),
  path.join('.codex-plugin', 'plugin.json'),
] as const;

/** A `.mcp.json` file: the servers under `mcpServers`, or the map itself. */
const McpFileSchema = z.record(z.string(), z.unknown());

/**
 * Components that run code other than a declared MCP server. A plugin with
 * any of them is a code plugin, which TeXRA refuses to enable until it can
 * run one out of process behind a typed boundary.
 */
const CODE_COMPONENTS = [
  { label: 'hooks', field: 'hooks', files: [path.join('hooks', 'hooks.json')] },
  { label: 'LSP servers', field: 'lspServers', files: ['.lsp.json'] },
] as const;

/** Data components TeXRA does not load. They are reported, never read. */
const IGNORED_COMPONENTS = [
  { label: 'output styles', field: 'outputStyles', files: ['output-styles'] },
  { label: 'apps', field: 'apps', files: ['.app.json'] },
] as const;

/** Every component label a plugin can carry that TeXRA does not load. */
export const UNLOADED_COMPONENT_LABELS = [
  ...CODE_COMPONENTS,
  ...IGNORED_COMPONENTS,
].map((component) => component.label);

/** Whether `relative` (from `path.relative`) climbs out of its base. */
const escapes = (relative: string) =>
  relative === '..' ||
  relative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relative);

const pluginIo = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new PluginError({ message: toErrorMessage(error) }),
  });

const pathExists = (target: string) =>
  Effect.tryPromise({ try: () => fs.stat(target), catch: ensureError }).pipe(
    Effect.as(true),
    Effect.catchIf(isFileNotFoundError, () => Effect.succeed(false)),
    Effect.mapError((error) => new PluginError({ message: error.message })),
  );

/** Read and validate one JSON file, or `undefined` when it is absent. */
export function readJsonFile<T>(file: string, schema: z.ZodType<T>) {
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
      return yield* failPlugin(
        `${file} does not match the expected shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  });
}

/**
 * Resolve a path a plugin declares against the directory it is relative to,
 * refusing any that could leave it: absolute paths, `..` segments that climb
 * out, and symlinks whose target lies outside. `undefined` when it does not
 * exist.
 */
export function containedPath(root: string, declared: string) {
  return Effect.gen(function* () {
    const resolved = path.resolve(root, declared);
    const relative = path.relative(root, resolved);
    if (path.isAbsolute(declared) || escapes(relative)) {
      return yield* failPlugin(
        `Plugin path "${declared}" points outside the plugin directory ${root}.`,
      );
    }
    if (!(yield* pathExists(resolved))) return undefined;
    const [realRoot, realResolved] = yield* pluginIo(() =>
      Promise.all([fs.realpath(root), fs.realpath(resolved)]),
    );
    if (escapes(path.relative(realRoot, realResolved))) {
      return yield* failPlugin(
        `Plugin path "${declared}" resolves through a symlink to ${realResolved}, outside the plugin directory ${root}.`,
      );
    }
    return resolved;
  });
}

const toList = (paths: string | readonly string[] | undefined) =>
  paths === undefined ? [] : [paths].flat();

/** What stands in for a missing manifest: a name and skill paths. */
export type PluginFallback = Pick<
  PluginManifest,
  'name' | 'version' | 'description' | 'skills'
>;

/** One plugin read from its directory, before anything is recorded. */
export interface ResolvedPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Skill roots relative to the plugin directory. */
  readonly skills: readonly string[];
  /** Command files (`*.md`) relative to the plugin directory. */
  readonly commands: readonly string[];
  /** Agent files (`*.md`) relative to the plugin directory. */
  readonly agents: readonly string[];
  /** Its stdio MCP servers, `${CLAUDE_PLUGIN_ROOT}` expanded, each run in
   *  the plugin directory under the name `plugin_<plugin>_<server>`. */
  readonly mcpServers: readonly McpServerConfig[];
  /** Labels of the components that run code other than an MCP server. */
  readonly code: readonly string[];
  /** Labels of the data components TeXRA does not load. */
  readonly ignored: readonly string[];
  /** MCP server entries that were skipped, and why. */
  readonly warnings: readonly string[];
}

/** The plugin manifests present in `dir`, Claude Code's first. */
export function readPluginManifests(dir: string) {
  return Effect.forEach(PLUGIN_MANIFEST_FILES, (file) =>
    readJsonFile(path.join(dir, file), PluginManifestSchema),
  ).pipe(
    Effect.map((found) =>
      found.filter((manifest): manifest is PluginManifest => !!manifest),
    ),
  );
}

/**
 * The `*.md` files a component names: its conventional directory when
 * present plus every path the manifests declare (a file, or a directory
 * whose top-level `*.md` files count), relative to `dir`.
 */
function markdownFiles(
  dir: string,
  conventional: string,
  declared: readonly string[],
) {
  return Effect.gen(function* () {
    const files = new Set<string>();
    for (const [index, candidate] of [conventional, ...declared].entries()) {
      const resolved = yield* containedPath(dir, candidate);
      if (resolved === undefined) {
        if (index === 0) continue;
        return yield* failPlugin(
          `The plugin at ${dir} declares "${candidate}", which does not exist.`,
        );
      }
      const stat = yield* pluginIo(() => fs.stat(resolved));
      const entries = stat.isDirectory()
        ? (yield* pluginIo(() => fs.readdir(resolved)))
            .filter((name) => name.endsWith('.md'))
            .toSorted()
            .map((name) => path.join(resolved, name))
        : [resolved];
      for (const entry of entries) {
        const file = yield* containedPath(dir, path.relative(dir, entry));
        if (file !== undefined) files.add(path.relative(dir, file));
      }
    }
    return [...files];
  });
}

/** Replace `${CLAUDE_PLUGIN_ROOT}` with the plugin directory. */
const expandRoot = (dir: string, value: string) =>
  value.replaceAll('${CLAUDE_PLUGIN_ROOT}', dir);

/**
 * The stdio MCP servers a plugin declares, inline in its manifest or in the
 * files it names, else in `.mcp.json` when present; each file holds its
 * servers under `mcpServers` or as the whole object.
 */
function mcpServersOf(dir: string, name: string, manifests: PluginManifest[]) {
  return Effect.gen(function* () {
    const declared = manifests.flatMap((manifest) =>
      manifest.mcpServers === undefined ? [] : [manifest.mcpServers],
    );
    const maps: { where: string; servers: Record<string, unknown> }[] = [];
    const files = declared.flatMap((entry) =>
      typeof entry === 'string' || Array.isArray(entry) ? toList(entry) : [],
    );
    for (const entry of declared) {
      if (typeof entry !== 'string' && !Array.isArray(entry))
        maps.push({ where: `the manifest of ${name}`, servers: entry });
    }
    if (
      declared.length === 0 &&
      (yield* pathExists(path.join(dir, '.mcp.json')))
    )
      files.push('.mcp.json');
    // Both manifests may name the same file: it is read once.
    const read = new Set<string>();
    for (const file of files) {
      const resolved = yield* containedPath(dir, file);
      if (resolved === undefined)
        return yield* failPlugin(
          `Plugin ${name} declares MCP servers in "${file}", which does not exist.`,
        );
      if (read.has(resolved)) continue;
      read.add(resolved);
      const json = (yield* readJsonFile(resolved, McpFileSchema)) ?? {};
      const inner = McpFileSchema.safeParse(json.mcpServers);
      maps.push({
        where: resolved,
        servers: inner.success ? inner.data : json,
      });
    }
    const servers: McpServerConfig[] = [];
    const warnings: string[] = [];
    for (const { where, servers: map } of maps) {
      const parsed = parseMcpServers(where, map);
      warnings.push(...parsed.warnings);
      for (const server of parsed.servers) {
        servers.push({
          name: `plugin_${name}_${server.name}`,
          command: expandRoot(dir, server.command),
          args: server.args.map((arg) => expandRoot(dir, arg)),
          env: Object.fromEntries(
            Object.entries(server.env).map(([key, value]) => [
              key,
              expandRoot(dir, value),
            ]),
          ),
          cwd: dir,
        });
      }
    }
    const names = servers.map((server) => server.name);
    const clash = names.find(
      (server, index) => names.indexOf(server) !== index,
    );
    if (clash !== undefined)
      return yield* failPlugin(`Plugin ${name} declares ${clash} twice.`);
    return { servers, warnings };
  });
}

/** The labels of `components` that `dir` contains, by field or file. */
function presentComponents(
  dir: string,
  manifests: readonly PluginManifest[],
  components: readonly {
    readonly label: string;
    readonly field: keyof PluginManifest;
    readonly files: readonly string[];
  }[],
) {
  return Effect.filter(components, (component) =>
    manifests.some((manifest) => manifest[component.field] !== undefined)
      ? Effect.succeed(true)
      : Effect.map(
          Effect.forEach(component.files, (file) =>
            pathExists(path.join(dir, file)),
          ),
          (found) => found.some(Boolean),
        ),
  ).pipe(Effect.map((found) => found.map((component) => component.label)));
}

/**
 * Read the plugin in `dir`: its skill roots (the conventional `skills/`
 * directory when present plus every declared path), command and agent files,
 * MCP servers, and the components it carries that TeXRA does not load.
 * `fallback` stands in for a manifest when the directory has none: the
 * marketplace entry, as a non-strict Claude Code marketplace allows, or on a
 * reread the plugin's own record.
 */
export function readPlugin(dir: string, fallback?: PluginFallback) {
  return Effect.gen(function* () {
    const found = yield* readPluginManifests(dir);
    const manifests: PluginFallback[] = [...found];
    if (manifests.length === 0 && fallback) manifests.push(fallback);
    const primary = manifests[0];
    if (!primary) {
      return yield* failPlugin(
        `No plugin manifest in ${dir}: expected ${PLUGIN_MANIFEST_FILES.join(' or ')}.`,
      );
    }
    const name = SkillNameSchema.safeParse(primary.name);
    if (!name.success) {
      return yield* failPlugin(
        `Plugin name "${primary.name}" is not usable: ${name.error.issues[0]?.message ?? 'invalid name'}.`,
      );
    }
    // A plugin's MCP servers are named plugin_<plugin>_<server>: the plugin
    // name must fit a server name on its own.
    if (!ServerNameSchema.safeParse(name.data).success) {
      return yield* failPlugin(
        `Plugin name "${name.data}" is too long: use at most 32 characters.`,
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
        return yield* failPlugin(
          `Plugin ${name.data} declares skills at "${candidate}", which does not exist.`,
        );
      }
      skills.add(path.relative(dir, resolved) || '.');
    }
    const mcp = yield* mcpServersOf(dir, name.data, found);
    return {
      name: name.data,
      version: primary.version,
      description: primary.description,
      skills: [...skills],
      commands: yield* markdownFiles(
        dir,
        'commands',
        found.flatMap((manifest) => toList(manifest.commands)),
      ),
      agents: yield* markdownFiles(
        dir,
        'agents',
        found.flatMap((manifest) => toList(manifest.agents)),
      ),
      mcpServers: mcp.servers,
      code: yield* presentComponents(dir, found, CODE_COMPONENTS),
      ignored: yield* presentComponents(dir, found, IGNORED_COMPONENTS),
      warnings: mcp.warnings,
    } satisfies ResolvedPlugin;
  });
}

/** Count the skill directories (`<name>/SKILL.md`) under one skill root. */
export function countSkills(root: string) {
  return pluginIo(() => fs.readdir(root, { withFileTypes: true })).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(entries, (entry) =>
        entry.isDirectory() || entry.isSymbolicLink()
          ? pathExists(path.join(root, entry.name, 'SKILL.md'))
          : Effect.succeed(false),
      ),
    ),
    Effect.map((found) => found.filter(Boolean).length),
  );
}
