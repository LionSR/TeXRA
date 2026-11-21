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
// refused: the harness does not run them yet.

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Number as Num, Result } from 'effect';

// Local imports - shared contracts
import type { InstalledPlugin, PluginTrust } from '@shared/schemas';

// Local imports - plugin record, reading and digest
import type { SettingsStores } from '@shared/config/settings';
import { CommandDirs } from '@utils/system/platformPaths';
import {
  findInstalled,
  readInstalled,
  updateInstalled,
  type PluginEnv,
} from './installRecord';
import { revisionKey, type McpServerConfig } from './mcpServers';
import {
  describeProvides,
  NATIVE_ENTRY_FILE,
  type NativeEntry,
} from './nativeEntry';
import { externalFiles, pluginDigest } from './pluginDigest';
import { hookShell, NO_SHELL, pinHook } from './pluginHooks';
import {
  countSkills,
  PluginError,
  PluginRequestError,
  readPlugin,
  type ResolvedPlugin,
} from './pluginManifest';
import type { ConfiguredHook } from './hookConfig';

/**
 * Reread a recorded plugin's manifest. Its record stands in for a manifest
 * it never had (a plugin a marketplace entry described).
 */
export function rereadPlugin(
  plugin: InstalledPlugin,
): Effect.Effect<ResolvedPlugin, PluginError, FileSystem.FileSystem> {
  return readPlugin(plugin.path, {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    skills: plugin.skills.map((skill) => path.relative(plugin.path, skill)),
  });
}

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
  `Plugin ${name} ships ${plugin.code.join(', ')}, which this build does not run yet, so it cannot be enabled.`;

/** A hook's event, matcher and command, as the prompt and a listing show it. */
export const describeHook = (hook: ConfiguredHook): Effect.Effect<string> =>
  Effect.map(
    CommandDirs,
    (appDirs) =>
      `${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ''}: runs \`${[hook.command, ...(hook.args ?? [])].join(' ')}\` (timeout ${hook.timeoutSeconds}s)${hook.args === undefined && hookShell(appDirs()) === null ? `; ${NO_SHELL}` : ''}`,
  );

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
  /** The digest trusting it records. */
  readonly digest: string;
  /** Its folder. */
  readonly path: string;
  /** What the plugin declares, one line each, for the prompt. */
  readonly lines: readonly string[];
  /** Its native entry, which runs inside the process once trusted: only a
   *  person's own answer trusts it. */
  readonly native: NativeEntry | null;
}

/** How many skills the plugin's skill directories hold. */
const pluginSkillCount = (record: InstalledPlugin, plugin: ResolvedPlugin) =>
  Effect.forEach(
    plugin.skills.map((skill) => path.join(record.path, skill)),
    countSkills,
    { concurrency: 'unbounded' },
  ).pipe(Effect.map(Num.sumAll));

/** The capabilities a plugin declares, as the trust prompt lists them. */
const reviewLines = Effect.fn('pluginTrust.reviewLines')(function* (
  record: InstalledPlugin,
  plugin: ResolvedPlugin,
) {
  const skillCount = yield* pluginSkillCount(record, plugin);
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
  const { loaded, refused } = plugin.programs;
  if (loaded.length === 0 && refused.length === 0) lines.push('Programs: none');
  else {
    lines.push(
      'Programs (each is JavaScript the plugin wrote, run in the script sandbox when you or a model starts it by name; it acts only through the tools it lists, which your tool switches and approvals still govern, and the agents it starts are not asked about one by one):',
    );
    for (const program of loaded)
      lines.push(
        `  ${program.name}: ${program.description} (tools: ${program.tools.join(', ') || 'none'})`,
      );
    for (const line of refused) lines.push(`  ${line}`);
  }
  if (plugin.native === null) lines.push('Native code: none');
  else
    lines.push(
      `Native code (${NATIVE_ENTRY_FILE}: ${plugin.native.description}): a module that runs inside this process, as you, with everything the process can reach (your files, the network, your credentials and every open session). It is not sandboxed. Each call of its tools asks under your approval policy, as an MCP server’s tool does, whatever the module declares; a call that fails, crashes or runs past its deadline fails alone. What it does outside an Effect cannot be contained: a loop that never yields, \`process.exit\` or a crash in a native addon stops this process.`,
      `  It contributes ${describeProvides(plugin.native.provides)}; a module that contributes anything else is not loaded.`,
    );
  const { hooks, unsupported } = plugin.hooks;
  if (hooks.length === 0) lines.push('Hooks: none');
  else {
    lines.push(
      'Hooks (each runs as a process in the workspace, as you, with only PATH, HOME and the CLAUDE_* paths set; it can deny a tool call, rewrite its input, answer the approval the call would ask for or ask a person instead, add text the model reads, and keep a run going past the end of a turn once; it cannot approve what the approval policy denies):',
    );
    for (const hook of hooks) {
      lines.push(`  ${yield* describeHook(hook)}`);
      const pin = yield* pinHook(record.path, hook);
      if (pin.kind === 'dynamic') {
        lines.push(
          `    cannot pin what this runs (${pin.reason}): trust covers its exact text, ${JSON.stringify([hook.command, ...(hook.args ?? [])].join(' '))}, and a change to it asks again`,
        );
        continue;
      }
      for (const file of pin.files) {
        if (file.kind === 'program')
          lines.push(
            `    program: ${file.path} (trusted by its path, size and date, not its content)`,
          );
        else if (file.sha256 === null)
          lines.push(
            `    names ${file.path}, outside the plugin, which does not exist now (creating it asks again)`,
          );
        else
          lines.push(
            `    runs ${file.path}, outside the plugin (trusted by its content: an edit asks again)`,
          );
      }
    }
  }
  if (unsupported.length > 0)
    lines.push(
      'Hooks this build does not run:',
      ...unsupported.map((line) => `  ${line}`),
    );
  lines.push(
    'Trust covers this version, every file in the plugin, its servers’ settings, each hook’s text and the scripts its hooks run: a change to any of them asks again.',
  );
  if (plugin.ignored.length > 0)
    lines.push(`Not loaded: ${plugin.ignored.join(', ')}`);
  lines.push(...plugin.warnings);
  return lines;
});

/** The recorded plugin `name` as it is now, with the trust it needs; a
 *  code plugin is refused. */
const readRecorded = Effect.fn('pluginTrust.readRecorded')(function* (
  name: string,
  env: PluginEnv,
) {
  const record = yield* Effect.fromResult(
    findInstalled(yield* readInstalled(env), name),
  );
  const plugin = yield* rereadPlugin(record);
  if (plugin.code.length > 0)
    return yield* new PluginError({ message: codeRefusal(name, plugin) });
  const key = yield* trustKey(record, plugin, yield* envKeyOf(env));
  return { record, plugin, key };
});

/** What trusting `record` as it is now (`key`) asks. */
const reviewOf = Effect.fn('pluginTrust.reviewOf')(function* (
  record: InstalledPlugin,
  plugin: ResolvedPlugin,
  key: PluginTrust,
) {
  return {
    name: record.name,
    version: key.version,
    digest: key.digest,
    path: record.path,
    lines: yield* reviewLines(record, plugin),
    native: plugin.native,
  } satisfies PluginReview;
});

/**
 * The recorded plugin `name`'s review as it is now, whether it is trusted
 * as it is and whether it is enabled: what a caller that decides to ask
 * before enabling reads. A code plugin is refused.
 */
export const reviewPlugin = Effect.fn('reviewPlugin')(function* (
  name: string,
  env: PluginEnv,
) {
  const { record, plugin, key } = yield* readRecorded(name, env);
  return {
    review: yield* reviewOf(record, plugin, key),
    trusted: trusts(record, key),
    enabled: record.enabled,
  };
});

/**
 * Enable a recorded plugin. A plugin the user already trusts as it is now
 * is enabled at once; otherwise `confirm` shows what it declares, and only
 * an accepted review is recorded, with the switch, in one write. A code
 * plugin is refused before anything is asked.
 */
export const enablePlugin = Effect.fn('enablePlugin')(function* <E, R>(
  name: string,
  env: PluginEnv,
  confirm: (review: PluginReview) => Effect.Effect<boolean, E, R>,
) {
  const { record, plugin, key } = yield* readRecorded(name, env);
  if (!trusts(record, key)) {
    const accepted = yield* confirm(yield* reviewOf(record, plugin, key));
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

/** Disable a recorded plugin: it stays installed, pinned and trusted, and
 *  contributes nothing from each host's next step. */
export const disablePlugin = (name: string, env: PluginEnv) =>
  updateInstalled(env, name, (found) => ({ ...found, enabled: false }));

/** One installed plugin as a listing reports it. */
export interface PluginListing extends InstalledPlugin {
  readonly skillCount: number;
  readonly commandCount: number;
  readonly agentCount: number;
  /** The programs it carries, by the name each is started by. */
  readonly programs: readonly string[];
  /** Its MCP servers' names, as its tools carry them. */
  readonly mcpServers: readonly string[];
  /** Its native entry, as its file declares it. */
  readonly native: NativeEntry | null;
  /** Whether the user trusts it as it is now. */
  readonly trusted: boolean;
  /** Its command hooks, and the configured ones the harness does not run. */
  readonly hooks: readonly ConfiguredHook[];
  readonly unsupportedHooks: readonly string[];
  /** Code components, which keep it from being enabled (LSP servers). */
  readonly code: readonly string[];
  readonly ignored: readonly string[];
  /** Why the plugin cannot be read now, when it cannot. */
  readonly problem?: string;
}

export const listPlugins = Effect.fn('listPlugins')(function* (env: PluginEnv) {
  const installed = yield* readInstalled(env);
  const envKey = yield* envKeyOf(env);
  return yield* Effect.forEach(
    installed,
    (record): Effect.Effect<PluginListing, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const plugin = yield* rereadPlugin(record);
        const key = yield* trustKey(record, plugin, envKey);
        const skillCount = yield* pluginSkillCount(record, plugin);
        return {
          ...record,
          version: plugin.version,
          description: plugin.description,
          skillCount,
          commandCount: plugin.commands.length,
          agentCount: plugin.agents.length,
          programs: plugin.programs.loaded.map(({ name }) => name),
          mcpServers: plugin.mcpServers.map((server) => server.name),
          native: plugin.native,
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
            programs: [],
            mcpServers: [],
            native: null,
            trusted: false,
            hooks: [],
            unsupportedHooks: [],
            code: [],
            ignored: [],
            problem: error.message,
          } satisfies PluginListing),
        ),
      ),
    { concurrency: 4 },
  );
});

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
 *  not loaded (`plugin` null: none could be read). */
export interface InstalledPluginLoad {
  readonly loadable: readonly LoadablePlugin[];
  readonly withheld: readonly { plugin: string | null; reason: string }[];
  /** The per-install key their servers' env values are digested under,
   *  read when any plugin is enabled. */
  readonly envKey?: string;
}

/**
 * The enabled plugins that load now: each read from its directory, refused
 * when it ships LSP servers, and held back when its version or digest is not
 * what the user trusted. Never fails: an unreadable record or plugin loads
 * nothing and says why, so a store fault fails closed.
 */
export const readInstalledPluginLoad: (
  stores: Pick<SettingsStores, 'globalState'>,
) => Effect.Effect<InstalledPluginLoad, never, FileSystem.FileSystem> =
  Effect.fn('readInstalledPluginLoad')(
    function* (stores: Pick<SettingsStores, 'globalState'>) {
      const enabled = (yield* readInstalled(stores)).filter(
        (record) => record.enabled,
      );
      const loadable: LoadablePlugin[] = [];
      const withheld: { plugin: string; reason: string }[] = [];
      const withhold = (plugin: string, reason: string) =>
        withheld.push({ plugin, reason });
      if (enabled.length === 0) return { loadable, withheld };
      const envKey = yield* envKeyOf(stores);
      // Each plugin is read and digested at once, then judged in order.
      const reads = yield* Effect.forEach(
        enabled,
        (record) =>
          Effect.map(
            Effect.result(
              Effect.gen(function* () {
                const plugin = yield* rereadPlugin(record);
                return { plugin, key: yield* trustKey(record, plugin, envKey) };
              }),
            ),
            (read) => ({ record, read }),
          ),
        { concurrency: 4 },
      );
      for (const { record, read } of reads) {
        if (Result.isFailure(read)) {
          withhold(
            record.name,
            `Plugin ${record.name} is not loaded: ${read.failure.message}`,
          );
          continue;
        }
        const { plugin, key } = read.success;
        if (plugin.code.length > 0) {
          withhold(record.name, codeRefusal(record.name, plugin));
          continue;
        }
        if (!trusts(record, key)) {
          let change = 'what it ships or runs changed since you trusted it';
          if (record.trust === undefined)
            change = 'it is enabled but was never trusted';
          else if (record.trust.version !== key.version)
            change = `its version changed (${record.trust.version ?? 'none'} -> ${key.version ?? 'none'}) since you trusted it`;
          withhold(
            record.name,
            `Plugin ${record.name} is not loaded: ${change}. Enable it again to review it.`,
          );
          continue;
        }
        loadable.push({ record, plugin, trust: key });
      }
      return { loadable, withheld, envKey };
    },
    Effect.catch((error: PluginError | PluginRequestError) =>
      Effect.succeed({
        loadable: [],
        withheld: [
          {
            plugin: null,
            reason: `No installed plugin is loaded: ${error.message}`,
          },
        ],
      }),
    ),
  );
