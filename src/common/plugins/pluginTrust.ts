// Trust in an installed plugin, and what an enabled, trusted plugin loads.
//
// Enabling a plugin asks the user to trust the version it is at, showing
// what it declares (`enablePlugin`); the accepted decision is recorded in
// `texra.plugins.trusted` through the state store's single writer. The
// decision covers the plugin's name and version and a digest of what it
// runs: each MCP server's spec, the executable it resolves to, and the
// plugin's own files among them. That digest is not the config revision a
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
 * What one file a server runs is: its bytes' digest when the plugin ships
 * it, and otherwise its resolved path, size and modification time, so a
 * reinstalled or upgraded executable asks again without hashing a runtime
 * on every step.
 */
const fileFingerprint = (root: string, file: string) =>
  Effect.tryPromise({
    try: async () => {
      const real = await fs.realpath(file);
      if (within(await fs.realpath(root), real))
        return {
          file: path.relative(root, real),
          sha256: sha256(await fs.readFile(real)),
        };
      const stat = await fs.stat(real);
      return { file: real, size: stat.size, mtimeMs: stat.mtimeMs };
    },
    catch: (error) =>
      new PluginError({
        message: `Could not read ${file}: ${toErrorMessage(error)}`,
      }),
  });

/** The executable `command` names: a path against the plugin directory, or
 *  a name on PATH; `null` when it resolves to nothing. */
function resolveCommand(root: string, command: string): string | null {
  if (command.includes('/') || command.includes(path.sep))
    return path.resolve(root, command);
  return whichOnExtendedPath(command);
}

const isFile = (file: string) =>
  Effect.promise(() =>
    fs.stat(file).then(
      (stat) => stat.isFile(),
      () => false,
    ),
  );

/** One server's part of the digest: its spec, its executable and the
 *  plugin files its arguments name. */
const serverRuns = (root: string, server: McpServerConfig) =>
  Effect.gen(function* () {
    const executable = resolveCommand(root, server.command);
    const files = [];
    for (const arg of server.args) {
      const file = path.resolve(root, arg);
      if (within(root, file) && (yield* isFile(file)))
        files.push(yield* fileFingerprint(root, file));
    }
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env).toSorted(),
      executable:
        executable === null || !(yield* isFile(executable))
          ? null
          : yield* fileFingerprint(root, executable),
      files,
    };
  });

/** sha256 over what the plugin runs. A plugin that runs nothing digests its
 *  empty list, so its version alone keys its trust. */
const runsDigest = (root: string, plugin: ResolvedPlugin) =>
  Effect.map(
    Effect.forEach(plugin.mcpServers, (server) => serverRuns(root, server)),
    (runs) => sha256(stableStringify(runs) ?? ''),
  );

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
): string[] {
  const lines = [
    `Source: ${record.commit ? `${record.source} at ${record.commit.slice(0, 12)}` : `${record.source} (local)`}`,
    `Skills: ${skillCount}; commands: ${plugin.commands.length}; agents: ${plugin.agents.length} (loaded as ${plugin.name}:<name>)`,
  ];
  if (plugin.mcpServers.length === 0) lines.push('MCP servers: none');
  else
    lines.push(
      `MCP servers (each runs as a process on this machine, its tools approved like shell commands):`,
      ...plugin.mcpServers.map((server) => `  ${describeServer(server)}`),
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
        lines: reviewLines(record, plugin, skillCount),
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
