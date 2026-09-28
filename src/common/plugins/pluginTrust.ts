// Trust in an installed plugin, and what an enabled, trusted plugin loads.
//
// Enabling a plugin asks the user to trust it as it is, showing what it
// declares (`enablePlugin`); the accepted decision is recorded in the
// plugin's row of the install record through the state store's single
// writer. The decision covers the plugin's version and its digest
// (`./pluginDigest`): every file it ships, and each MCP server's spec, env
// values and the files outside the plugin it runs, and the scripts its
// hooks run outside the plugin. A changed digest asks again.
//
// Hooks run out of process (`./pluginHooks`). A plugin with LSP servers is
// refused: TeXRA does not run them yet.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result } from 'effect';

// Local imports - shared contracts
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { InstalledPlugin, PluginTrust } from '@shared/schemas';

// Local imports - plugin record, reading and digest
import { rereadPlugin } from './installedPlugins';
import {
  findInstalled,
  readInstalled,
  updateInstalled,
  type PluginEnv,
} from './installRecord';
import { revisionKey, type McpServerConfig } from './mcpServers';
import { externalFiles, pluginDigest } from './pluginDigest';
import { hookFiles } from './pluginHooks';
import {
  countSkills,
  PluginError,
  PluginRequestError,
  type ResolvedPlugin,
} from './pluginManifest';
import type { ConfiguredHook } from './hookConfig';

/** The trust decision the plugin needs now, its env digested under `key`. */
const trustKey = (
  record: InstalledPlugin,
  plugin: ResolvedPlugin,
  key: string,
) =>
  Effect.map(pluginDigest(record.path, plugin, key), (digest): PluginTrust => ({
    version: plugin.version ?? null,
    digest,
  }));

const trusts = (record: InstalledPlugin, key: PluginTrust) =>
  record.trust?.version === key.version && record.trust.digest === key.digest;

/** The per-install key env values are digested under, as a plugin error. */
const envKeyOf = (stores: Pick<SettingsStores, 'globalState'>) =>
  revisionKey(stores.globalState).pipe(
    Effect.mapError((error) => new PluginError({ message: error.message })),
  );

/** Why a plugin with LSP servers is refused. */
const codeRefusal = (name: string, plugin: ResolvedPlugin) =>
  `Plugin ${name} ships ${plugin.code.join(', ')}, which TeXRA does not run yet, so it cannot be enabled.`;

/** A hook's event, matcher and command, as the prompt and a listing show it. */
export const describeHook = (hook: ConfiguredHook) =>
  `${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ''}: runs \`${[hook.command, ...(hook.args ?? [])].join(' ')}\` (timeout ${hook.timeoutSeconds}s)`;

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
const reviewLines = (record: InstalledPlugin, plugin: ResolvedPlugin) =>
  Effect.gen(function* () {
    const skillCount = (yield* Effect.forEach(
      plugin.skills.map((skill) => path.join(record.path, skill)),
      countSkills,
    )).reduce((sum, count) => sum + count, 0);
    const lines = [
      `Source: ${record.commit ? `${record.source} at ${record.commit.slice(0, 12)}` : `${record.source} (local)`}`,
      `Skills: ${skillCount}; commands: ${plugin.commands.length}; agents: ${plugin.agents.length} (loaded as ${plugin.name}:<name>)`,
    ];
    if (plugin.mcpServers.length === 0) lines.push('MCP servers: none');
    else {
      lines.push(
        'MCP servers (each runs as a process on this machine, its tools approved like shell commands):',
      );
      for (const server of plugin.mcpServers) {
        lines.push(`  ${describeServer(server)}`);
        for (const external of yield* externalFiles(record.path, server))
          lines.push(
            `    external ${external.role}: ${external.path} (trusted by its path, size and date, not its content)`,
          );
      }
    }
    const { hooks, unsupported } = plugin.hooks;
    if (hooks.length === 0) lines.push('Hooks: none');
    else {
      lines.push(
        'Hooks (each runs as a process in the workspace, as you, with only PATH, HOME and the CLAUDE_* paths set; it can deny a tool call and add text the model reads):',
      );
      for (const hook of hooks) {
        lines.push(`  ${describeHook(hook)}`);
        for (const file of yield* hookFiles(record.path, hook)) {
          if (file.kind === 'external')
            lines.push(
              `    runs ${file.path}, outside the plugin (trusted by its content: an edit asks again)`,
            );
          else if (file.kind === 'program')
            lines.push(
              `    program: ${file.path} (trusted by its path, size and date, not its content)`,
            );
          else
            lines.push(
              `    workspace file: ${file.path} (read when the hook runs, not covered by trust)`,
            );
        }
      }
    }
    if (unsupported.length > 0)
      lines.push(
        'Hooks TeXRA does not run:',
        ...unsupported.map((line) => `  ${line}`),
      );
    lines.push(
      'Trust covers this version, every file in the plugin, its servers’ settings and the scripts its hooks run: a change to any of them asks again.',
    );
    if (plugin.ignored.length > 0)
      lines.push(`Not loaded: ${plugin.ignored.join(', ')}`);
    lines.push(...plugin.warnings);
    return lines;
  });

/**
 * Enable a recorded plugin. A plugin the user already trusts as it is now
 * is enabled at once; otherwise `confirm` shows what it declares, and only
 * an accepted review is recorded, with the switch, in one write. A code
 * plugin is refused before anything is asked.
 */
export function enablePlugin<E, R>(
  name: string,
  env: PluginEnv,
  confirm: (review: PluginReview) => Effect.Effect<boolean, E, R>,
) {
  return Effect.gen(function* () {
    const record = yield* Effect.fromResult(
      findInstalled(yield* readInstalled(env), name),
    );
    const plugin = yield* rereadPlugin(record);
    if (plugin.code.length > 0)
      return yield* Effect.fail(
        new PluginError({ message: codeRefusal(name, plugin) }),
      );
    const key = yield* trustKey(record, plugin, yield* envKeyOf(env));
    if (!trusts(record, key)) {
      const accepted = yield* confirm({
        name,
        version: key.version,
        lines: yield* reviewLines(record, plugin),
      });
      if (!accepted) return 'declined' as const;
    }
    // One decision per plugin: trusting it now replaces the last one.
    yield* updateInstalled(env, name, (found) => ({
      ...found,
      enabled: true,
      trust: key,
    }));
    return 'enabled' as const;
  });
}

/** Disable a recorded plugin: it stays installed, pinned and trusted, and
 *  contributes nothing from each host's next step. */
export const disablePlugin = (name: string, env: PluginEnv) =>
  updateInstalled(env, name, (found) => ({ ...found, enabled: false }));

/** One installed plugin as a listing reports it. */
export interface PluginListing extends InstalledPlugin {
  readonly skillCount: number;
  readonly commandCount: number;
  readonly agentCount: number;
  /** Its MCP servers' names, as its tools carry them. */
  readonly mcpServers: readonly string[];
  /** Whether the user trusts it as it is now. */
  readonly trusted: boolean;
  /** Its command hooks, and the configured ones TeXRA does not run. */
  readonly hooks: readonly ConfiguredHook[];
  readonly unsupportedHooks: readonly string[];
  /** Code components, which keep it from being enabled (LSP servers). */
  readonly code: readonly string[];
  readonly ignored: readonly string[];
  /** Why the plugin cannot be read now, when it cannot. */
  readonly problem?: string;
}

export function listPlugins(env: PluginEnv) {
  return Effect.gen(function* () {
    const installed = yield* readInstalled(env);
    const envKey = yield* envKeyOf(env);
    return yield* Effect.forEach(
      installed,
      (record): Effect.Effect<PluginListing, never, FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const plugin = yield* rereadPlugin(record);
          const key = yield* trustKey(record, plugin, envKey);
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
            trusted: trusts(record, key),
            hooks: plugin.hooks.hooks,
            unsupportedHooks: plugin.hooks.unsupported,
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
              hooks: [],
              unsupportedHooks: [],
              code: [],
              ignored: [],
              problem: error.message,
            } satisfies PluginListing),
          ),
        ),
    );
  });
}

/** The id every installed Claude Code or Codex plugin's contributions
 *  carry, its tools and its skills alike: `plugin:<name>`. */
export const installedPluginId = (name: string): string => `plugin:${name}`;

/** Whether a catalog entry's plugin is an installed plugin. */
export const isInstalledPluginId = (plugin: string): boolean =>
  plugin.startsWith('plugin:');

/** An enabled plugin the user trusts as it is, as read now. */
export interface LoadablePlugin {
  readonly record: InstalledPlugin;
  readonly plugin: ResolvedPlugin;
  /** The decision it loads under: what it ships or runs changes exactly
   *  when this does, so a loader keyed on it restarts what it started. */
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
 * when it ships LSP servers, and held back when its version or digest is not
 * what the user trusted. Never fails: an unreadable record or plugin loads
 * nothing and says why, so a store fault fails closed.
 */
export function readInstalledPluginLoad(
  stores: Pick<SettingsStores, 'globalState'>,
): Effect.Effect<InstalledPluginLoad, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const enabled = (yield* readInstalled(stores)).filter(
      (record) => record.enabled,
    );
    const loadable: LoadablePlugin[] = [];
    const withheld: string[] = [];
    if (enabled.length === 0) return { loadable, withheld };
    const envKey = yield* envKeyOf(stores);
    for (const record of enabled) {
      const read = yield* Effect.result(
        Effect.gen(function* () {
          const plugin = yield* rereadPlugin(record);
          return { plugin, key: yield* trustKey(record, plugin, envKey) };
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
      if (!trusts(record, key)) {
        let change = 'what it ships or runs changed since you trusted it';
        if (record.trust === undefined)
          change = 'it is enabled but was never trusted';
        else if (record.trust.version !== key.version)
          change = `its version changed (${record.trust.version ?? 'none'} -> ${key.version ?? 'none'}) since you trusted it`;
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

/**
 * {@link readInstalledPluginLoad}, run once on first use and then answered
 * from that read: what one launch's consumers share (a plugin agent's check
 * and the skill catalog). Nothing is read if none asks. A run's steps never
 * take it: each step reads the plugins again, as the trust and ordering
 * authority for what the run loads.
 */
export const readInstalledPluginLoadOnce = (
  stores: Pick<SettingsStores, 'globalState'>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.cached(
      readInstalledPluginLoad(stores).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
  });
