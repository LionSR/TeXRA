// Trust in an installed plugin, and what an enabled, trusted plugin loads.
//
// Enabling a plugin asks the user to trust the version it is at, showing
// what it declares (`enablePlugin`); the accepted decision is recorded in
// `texra.plugins.trusted` through the state store's single writer. The
// decision covers the plugin's name and version and a digest of what it
// ships and runs: every file under its root, and each MCP server's spec and
// the external executable it resolves to (by path, size and date). That
// digest is not the config revision a
// tool's identity carries (`@tools/liveTools`): it changes when what runs
// changes, and a changed digest asks again.
//
// A plugin that runs code other than a declared MCP server (hooks, LSP
// servers) is a code plugin. TeXRA refuses to enable one until it can run it
// out of process behind a typed boundary.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, Result } from 'effect';
import stableStringify from 'safe-stable-stringify';

import type { SettingsStores } from '@shared/config/settingsAccess';
import type { InstalledPlugin, PluginTrust } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { whichOnExtendedPath } from '@utils/system/platformPaths';

import { rereadPlugin } from './installedPlugins';
import {
  findInstalled,
  modifyInstalled,
  modifyTrusted,
  readPluginState,
  type PluginEnv,
} from './installRecord';
import {
  countSkills,
  PluginError,
  PluginRequestError,
  type ResolvedPlugin,
} from './pluginManifest';
import type { McpServerConfig } from './mcpServers';

const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};

/**
 * Content hashes by (path, size, mtime), for this process: a plugin's files
 * are digested at every step that loads it, and an unchanged file is read
 * once. An entry holds only a hash of bytes that key names.
 */
const contentHashes = new Map<string, string>();

/**
 * Every file under the plugin root, as sorted `[path, sha256]` pairs; `.git`
 * is skipped, and a symlink digests its target text rather than following
 * it. Any edit inside the plugin, a script a server imports included,
 * changes it.
 */
const pluginFiles = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      const files: [string, string][] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relative = path.relative(root, full);
          if (entry.isDirectory()) {
            if (entry.name !== '.git') await walk(full);
          } else if (entry.isSymbolicLink()) {
            files.push([relative, `-> ${await fs.readlink(full)}`]);
          } else if (entry.isFile()) {
            const stat = await fs.stat(full);
            const key = `${full}\0${stat.size}\0${stat.mtimeMs}`;
            let hash = contentHashes.get(key);
            if (hash === undefined) {
              hash = sha256(await fs.readFile(full));
              contentHashes.set(key, hash);
            }
            files.push([relative, hash]);
          }
        }
      };
      await walk(root);
      return files.toSorted(([a], [b]) => Number(a > b) - Number(a < b));
    },
    catch: (error) =>
      new PluginError({
        message: `Could not read the plugin at ${root}: ${toErrorMessage(error)}`,
      }),
  });

/** The executable `command` names: a path against the plugin directory, or
 *  a name on PATH; `null` when it resolves to nothing. */
function resolveCommand(root: string, command: string): string | null {
  if (command.includes('/') || command.includes(path.sep))
    return path.resolve(root, command);
  return whichOnExtendedPath(command);
}

/**
 * The executable a server runs when it lies outside the plugin (`node`,
 * `uvx`): its resolved path, size and modification time. It is not hashed,
 * so an upgraded runtime asks again without being read on every step, but
 * its content is not pinned. `null` when the command is the plugin's own
 * (its files cover it) or resolves to no file, which fails the server's
 * start loudly.
 */
const externalCommand = (root: string, server: McpServerConfig) =>
  Effect.promise(async () => {
    const resolved = resolveCommand(root, server.command);
    if (resolved === null) return null;
    const [realRoot, real] = await Promise.all([
      fs.realpath(root),
      fs.realpath(resolved).catch(() => null),
    ]);
    if (real === null || within(realRoot, real)) return null;
    const stat = await fs.stat(real);
    return stat.isFile()
      ? { path: real, size: stat.size, mtimeMs: stat.mtimeMs }
      : null;
  });

/**
 * sha256 over what the plugin ships and runs: every file under its root,
 * and each server's spec and the external command it resolves to.
 */
const runsDigest = (root: string, plugin: ResolvedPlugin) =>
  Effect.gen(function* () {
    const files = yield* pluginFiles(root);
    const servers = yield* Effect.forEach(plugin.mcpServers, (server) =>
      Effect.map(externalCommand(root, server), (external) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        envKeys: Object.keys(server.env).toSorted(),
        external,
      })),
    );
    return sha256(stableStringify({ files, servers }) ?? '');
  });

/** The trust decision the plugin needs now. */
const trustKey = (record: InstalledPlugin, plugin: ResolvedPlugin) =>
  Effect.map(runsDigest(record.path, plugin), (digest): PluginTrust => ({
    name: record.name,
    version: plugin.version ?? null,
    digest,
  }));

const sameTrust = (a: PluginTrust, b: PluginTrust) =>
  a.name === b.name && a.version === b.version && a.digest === b.digest;

/** Why a plugin that declares code is refused. */
const codeRefusal = (name: string, plugin: ResolvedPlugin) =>
  `Plugin ${name} runs code (${plugin.code.join(', ')}). Code plugins are not supported yet: TeXRA runs only a plugin's declared MCP servers, each in its own process.`;

const describeServer = (server: McpServerConfig) =>
  `${server.name.replace(/^plugin_[^_]+_/, '')}: runs \`${[server.command, ...server.args].join(' ')}\`${
    Object.keys(server.env).length > 0
      ? ` with ${Object.keys(server.env).toSorted().join(', ')} set`
      : ''
  }`;

/** What enabling a plugin asks the user to trust. */
export interface PluginReview {
  readonly name: string;
  readonly version: string | null;
  /** What the plugin declares, one line each, for the prompt. */
  readonly lines: readonly string[];
}

/** The capabilities a plugin declares, as the trust prompt lists them. */
function reviewLines(
  record: InstalledPlugin,
  plugin: ResolvedPlugin,
  skillCount: number,
  external: readonly (string | null)[],
): string[] {
  const lines = [
    `Source: ${record.commit ? `${record.source} at ${record.commit.slice(0, 12)}` : `${record.source} (local)`}`,
    `Skills: ${skillCount}; commands: ${plugin.commands.length}; agents: ${plugin.agents.length} (loaded as ${plugin.name}:<name>)`,
  ];
  if (plugin.mcpServers.length === 0) lines.push('MCP servers: none');
  else
    lines.push(
      `MCP servers (each runs as a process on this machine, its tools approved like shell commands):`,
      ...plugin.mcpServers.flatMap((server, index) => [
        `  ${describeServer(server)}`,
        ...(external[index] == null
          ? []
          : [
              `    external command: ${external[index]} (trusted by its path, size and date, not its content)`,
            ]),
      ]),
    );
  lines.push(
    'Trust covers this version and every file in the plugin: an edit to any of them asks again.',
  );
  if (plugin.ignored.length > 0)
    lines.push(`Not loaded: ${plugin.ignored.join(', ')}`);
  lines.push(...plugin.warnings);
  return lines;
}

/**
 * Enable a recorded plugin. A plugin whose current version and digest the
 * user already trusts is enabled at once; otherwise `confirm` shows what it
 * declares, and only an accepted review is recorded and enables it. A code
 * plugin is refused before anything is asked.
 */
export function enablePlugin<E, R>(
  name: string,
  env: PluginEnv,
  confirm: (review: PluginReview) => Effect.Effect<boolean, E, R>,
) {
  return Effect.gen(function* () {
    const { installed, trusted } = yield* readPluginState(env);
    const record = yield* Effect.fromResult(findInstalled(installed, name));
    const plugin = yield* rereadPlugin(record);
    if (plugin.code.length > 0)
      return yield* Effect.fail(
        new PluginError({ message: codeRefusal(name, plugin) }),
      );
    const key = yield* trustKey(record, plugin);
    if (!trusted.some((entry) => sameTrust(entry, key))) {
      const skillCount = (yield* Effect.forEach(
        plugin.skills.map((skill) => path.join(record.path, skill)),
        countSkills,
      )).reduce((sum, count) => sum + count, 0);
      const accepted = yield* confirm({
        name,
        version: key.version,
        lines: reviewLines(
          record,
          plugin,
          skillCount,
          yield* Effect.forEach(plugin.mcpServers, (server) =>
            Effect.map(
              externalCommand(record.path, server),
              (external) => external?.path ?? null,
            ),
          ),
        ),
      });
      if (!accepted) return 'declined' as const;
      // One decision per plugin: trusting a version replaces the last one.
      yield* modifyTrusted(env, (current) => [
        ...current.filter((entry) => entry.name !== name),
        key,
      ]);
    }
    yield* setEnabled(name, true, env);
    return 'enabled' as const;
  });
}

/** Switch a recorded plugin on or off in the record. */
function setEnabled(name: string, enabled: boolean, env: PluginEnv) {
  return modifyInstalled(env, (current) =>
    Result.map(
      findInstalled(current, name),
      (found) =>
        [
          current.map((entry) =>
            entry === found ? { ...entry, enabled } : entry,
          ),
          undefined,
        ] as const,
    ),
  );
}

/** Disable a recorded plugin: it stays installed, pinned and trusted, and
 *  contributes nothing from each host's next step. */
export const disablePlugin = (name: string, env: PluginEnv) =>
  setEnabled(name, false, env);

/** One installed plugin as a listing reports it. */
export interface PluginListing extends InstalledPlugin {
  readonly version?: string;
  readonly description?: string;
  readonly skillCount: number;
  readonly commandCount: number;
  readonly agentCount: number;
  /** Its MCP servers' names, as its tools carry them. */
  readonly mcpServers: readonly string[];
  /** Whether the user trusts it as it is now. */
  readonly trusted: boolean;
  /** Code components, which keep it from being enabled. */
  readonly code: readonly string[];
  readonly ignored: readonly string[];
  /** Why the plugin cannot be read now, when it cannot. */
  readonly problem?: string;
}

export function listPlugins(env: PluginEnv) {
  return Effect.gen(function* () {
    const { installed, trusted } = yield* readPluginState(env);
    return yield* Effect.forEach(
      installed,
      (record): Effect.Effect<PluginListing> =>
        Effect.gen(function* () {
          const plugin = yield* rereadPlugin(record);
          const key = yield* trustKey(record, plugin);
          const counts = yield* Effect.forEach(
            plugin.skills.map((skill) => path.join(record.path, skill)),
            countSkills,
          );
          return {
            ...record,
            version: plugin.version,
            description: plugin.description,
            skillCount: counts.reduce((sum, count) => sum + count, 0),
            commandCount: plugin.commands.length,
            agentCount: plugin.agents.length,
            mcpServers: plugin.mcpServers.map((server) => server.name),
            trusted: trusted.some((entry) => sameTrust(entry, key)),
            code: plugin.code,
            ignored: plugin.ignored,
          } satisfies PluginListing;
        }).pipe(
          Effect.catchTag('PluginError', (error) =>
            Effect.succeed({
              ...record,
              skillCount: 0,
              commandCount: 0,
              agentCount: 0,
              mcpServers: [],
              trusted: false,
              code: [],
              ignored: [],
              problem: error.message,
            } satisfies PluginListing),
          ),
        ),
    );
  });
}

/** An enabled plugin the user trusts at its current version, as read now. */
export interface LoadablePlugin {
  readonly record: InstalledPlugin;
  readonly plugin: ResolvedPlugin;
  /** The decision it loads under: what it runs changes exactly when this
   *  does, so a loader keyed on it restarts what it started. */
  readonly trust: PluginTrust;
}

/** What the enabled plugins load: the trusted ones, and why each other is
 *  not loaded. */
export interface InstalledPluginLoad {
  readonly loadable: readonly LoadablePlugin[];
  readonly withheld: readonly string[];
}

/**
 * The enabled plugins that load now: each read from its directory, refused
 * when it declares code, and held back when its version or what it runs is
 * not what the user trusted. Never fails: an unreadable record or plugin
 * loads nothing and says why, so a store fault fails closed.
 */
export function readInstalledPluginLoad(
  stores: Pick<SettingsStores, 'globalState'>,
): Effect.Effect<InstalledPluginLoad> {
  return Effect.gen(function* () {
    const { installed, trusted } = yield* readPluginState(stores);
    const loadable: LoadablePlugin[] = [];
    const withheld: string[] = [];
    for (const record of installed.filter(({ enabled }) => enabled)) {
      const read = yield* Effect.result(
        Effect.gen(function* () {
          const plugin = yield* rereadPlugin(record);
          return { plugin, key: yield* trustKey(record, plugin) };
        }),
      );
      if (Result.isFailure(read)) {
        withheld.push(
          `Plugin ${record.name} is not loaded: ${read.failure.message}`,
        );
        continue;
      }
      const { plugin, key } = read.success;
      if (plugin.code.length > 0) {
        withheld.push(codeRefusal(record.name, plugin));
        continue;
      }
      if (!trusted.some((entry) => sameTrust(entry, key))) {
        const last = trusted.find((entry) => entry.name === record.name);
        let change = 'what it runs changed since you trusted it';
        if (last === undefined) change = 'it is enabled but was never trusted';
        else if (last.version !== key.version)
          change = `its version changed (${last.version ?? 'none'} -> ${key.version ?? 'none'}) since you trusted it`;
        withheld.push(
          `Plugin ${record.name} is not loaded: ${change}. Enable it again to review it (\`texra plugin enable ${record.name}\`, or Settings > Skills).`,
        );
        continue;
      }
      loadable.push({ record, plugin, trust: key });
    }
    return { loadable, withheld };
  }).pipe(
    Effect.catch((error: PluginError | PluginRequestError) =>
      Effect.succeed({
        loadable: [],
        withheld: [`No installed plugin is loaded: ${error.message}`],
      }),
    ),
  );
}
