/**
 * MCP servers as loaded plugins (`@tools/toolTable`): the user's
 * `~/.texra/mcp.json`, in the `.mcp.json` shape Claude Code reads
 * (`{ "mcpServers": { "<name>": { "command", "args"?, "env"? } } }`), stdio
 * servers only.
 *
 * The file is read when a run resolves its tools and declares an MCP tool
 * (`mcp__<server>__<tool>`, or `mcp__<server>__*` for every tool the server
 * lists), and only the servers the declarations name become plugins, so a
 * run that declares none reads nothing and starts nothing. Each is plugin
 * `mcp:<server>`; its spec (name, command, args and env names) and a keyed
 * digest of its env values key its process, so an edited entry is a new
 * process beside the one open runs keep, and both are its recorded
 * revision: an edited entry gives its tools a new identity, and an
 * unchanged one keeps it across restarts.
 *
 * A project's servers run in its session's server pool (`projectServers`,
 * held by `@tools/sessionTools`): one process per server key (spec and
 * revision, an installed plugin's load key, the project's `.env`), shared
 * by the project's runs and steps, kept 30 minutes past its last holder
 * and stopped with the session; a start that failed stays failed until
 * the project's next root run, so one task waits on a dead start once.
 *
 * An entry that does not validate is skipped with a warning the resolving
 * run shows in its transcript. The project-level `.texra/mcp.json` is not
 * read: a checked-in file that spawns processes needs a trust prompt first.
 */
import * as path from 'node:path';

import {
  Duration,
  Effect,
  Equal,
  type FileSystem,
  Hash,
  Option,
  RcMap,
  type Scope,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { z } from 'zod';

import {
  envDigest,
  parseMcpServers,
  type McpServerConfig,
} from '@common/plugins/mcpServers';
import { TEXRA_STORAGE_DIR_NAME } from '@platform/defaults/nodeStorage';
import { ProjectEnvironment } from '@platform/defaults/nodeWorkspace';
import type {
  LoadedPlugin,
  LoadedPluginTools,
  PluginLoader,
} from '@tools/toolTable';
import { sha256 } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  acquireMcpServer,
  mcpPluginId,
  mcpServerOfToolName,
} from './mcpServer';

/** The config file's name inside the user's `~/.texra` directory. */
const MCP_CONFIG_FILE_NAME = 'mcp.json';

/** The MCP config file of a TeXRA storage root. */
export function mcpConfigPathOf(storageRoot: string): string {
  return path.join(storageRoot, MCP_CONFIG_FILE_NAME);
}

/** The user-level config file the hosts read: `~/.texra/mcp.json`. */
export const USER_MCP_CONFIG_PATH = mcpConfigPathOf(
  path.join(safeHomedir() ?? '/nonexistent', TEXRA_STORAGE_DIR_NAME),
);

const McpConfigFileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

/** The file's text, or `null` when it does not exist. */
const readConfigText = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<string | null, Error> =>
  fs.readFileString(file).pipe(
    Effect.map((text): string | null => text),
    Effect.catchIf(
      (error) => error.reason._tag === 'NotFound',
      () => Effect.succeed(null),
    ),
    Effect.mapError(
      (error) =>
        new Error(`Could not read ${file}: ${error.message}`, { cause: error }),
    ),
  );

/**
 * What `JSON.parse` rejected, without the file's text. V8 quotes an excerpt
 * of the source into the messages that carry no position, and this file
 * holds server credentials; those messages are cut at the first quote.
 */
function jsonSyntaxError(error: unknown): string {
  const message = toErrorMessage(error);
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(
    message,
  )?.[0];
  if (position === undefined)
    return (
      message.split(/['"]/, 1)[0].replace(/[,\s]+$/, '') || 'Unexpected content'
    );
  // Even a message with a position is cut at its first double quote, so a
  // V8 that one day quotes source there still leaks nothing; the position
  // itself is digits only.
  const kind = message.split('"', 1)[0].replace(/[,\s]+$/, '');
  return kind.includes(position) ? kind : `${kind} ${position}`;
}

/** Parse the config file's servers, skipping each invalid entry loudly. */
function parseConfig(
  file: string,
  json: unknown,
): ReturnType<typeof parseMcpServers> {
  const parsed = McpConfigFileSchema.safeParse(json);
  if (!parsed.success)
    return {
      servers: [],
      warnings: [
        `${file} must be { "mcpServers": { ... } }: ${z.prettifyError(parsed.error)}`,
      ],
    };
  return parseMcpServers(file, parsed.data.mcpServers);
}

/**
 * The config file's servers and the warnings its invalid entries raise, or
 * `null` when the file does not exist. Fails on an unreadable file or
 * invalid JSON. The Plugins page lists them read-only from here.
 */
export const readMcpConfig = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<ReturnType<typeof parseConfig> | null, Error> =>
  Effect.gen(function* () {
    const text = yield* readConfigText(fs, file);
    if (text === null) return null;
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) =>
        new Error(`${file} is not valid JSON: ${jsonSyntaxError(error)}`),
    });
    return parseConfig(file, json);
  });

/**
 * Every problem the config file at `file` has, for `texra doctor` and the
 * CLI's startup config warnings; a missing file has none, since MCP servers
 * are optional.
 */
export const mcpConfigWarnings = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<readonly string[]> =>
  readMcpConfig(fs, file).pipe(
    Effect.map((config) => config?.warnings ?? []),
    Effect.catch((error) => Effect.succeed([error.message])),
  );

/**
 * The plugin one server is, its env digested under `key`: a configured
 * server is its own plugin `mcp:<server>`; an installed plugin's servers go
 * under that plugin's `id`.
 */
export function mcpPlugin(
  config: McpServerConfig,
  key: string,
  id = mcpPluginId(config.name),
): LoadedPlugin {
  return {
    id,
    spec: {
      name: config.name,
      command: config.command,
      args: [...config.args],
      envKeys: Object.keys(config.env).toSorted(),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    },
    revision: envDigest(key, config.env),
    acquire: acquireMcpServer(config),
  };
}

/** The loader over the MCP config file at `file`, read through `fs`, with
 *  env values digested under the key `revisionKey` reads (`@common/plugins/mcpServers`),
 *  read only when a run declares an MCP tool. */
export const mcpPluginLoader =
  (
    fs: FileSystem.FileSystem,
    file: string,
    revisionKey: Effect.Effect<string, Error>,
  ): PluginLoader =>
  (declared) =>
    Effect.gen(function* () {
      const wanted = new Set(
        declared.flatMap((name) => mcpServerOfToolName(name) ?? []),
      );
      if (wanted.size === 0) return { plugins: [], warnings: [] };
      const config = yield* readMcpConfig(fs, file);
      if (config === null)
        return {
          plugins: [],
          warnings: [
            `The run declares MCP tools, but ${file} does not exist; no MCP server is configured.`,
          ],
        };
      const key = yield* revisionKey;
      return {
        plugins: config.servers
          .filter((server) => wanted.has(server.name))
          .map((server) => mcpPlugin(server, key)),
        warnings: config.warnings,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ plugins: [], warnings: [error.message] }),
      ),
    );

/** A project's server pool. */
export interface ProjectServers {
  /** A server of `plugin` (of the installed plugin with key `load`, if
   *  any) with the caller's project variables, for the caller's scope: its
   *  tools under its recorded revision, or why it has none. */
  readonly holdServer: (
    plugin: LoadedPlugin,
    load?: string,
  ) => Effect.Effect<HeldServer, never, Scope.Scope>;
  /** At a run's start (a root run first evicts failed starts): hold the
   *  configured MCP servers `declared` names, with the project variables. */
  readonly hold: (
    declared: readonly string[],
    root: boolean,
  ) => Effect.Effect<
    {
      readonly warnings: readonly string[];
      readonly held: readonly (HeldServer & { readonly id: string })[];
    },
    never,
    Scope.Scope
  >;
}

/** A held server's tools and the revision rows record, or why it has none. */
interface HeldServer extends LoadedPluginTools {
  readonly revision: string;
}

/** One MCP server process, equal by its plugin's spec and revision, the
 *  installed plugin's load key ('' if configured) and the project
 *  variables: a changed one is a new process beside the open ones. */
class ServerKey implements Equal.Equal {
  readonly id: string;
  readonly plugin: LoadedPlugin;
  readonly env: Readonly<Record<string, string>>;

  constructor(
    plugin: LoadedPlugin,
    env: Readonly<Record<string, string>>,
    load: string,
  ) {
    this.plugin = plugin;
    this.env = env;
    this.id = sha256([plugin.id, plugin.spec, plugin.revision, load, env]);
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof ServerKey && that.id === this.id;
  }

  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/** How long an MCP server no run or step holds stays up for the next: long
 *  enough to read an answer before replying. In the service, a session left
 *  idle closes sooner (`texra serve --idle-timeout`), and a session's close
 *  always stops its servers. */
const SERVER_IDLE = Duration.minutes(30);

/** The project's server pool, in the caller's scope (the session's). */
export const projectServers = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner['Service'],
  loader: PluginLoader,
) {
  // A server outlives its last holder by `SERVER_IDLE`, so the project's
  // next run (a chat's next message) reuses the process and its state; a
  // superseded key's process stops once that idle time passes, and the
  // session's close stops every one.
  const servers: RcMap.RcMap<ServerKey, LoadedPluginTools> = yield* RcMap.make({
    lookup: (key: ServerKey) =>
      key.plugin.acquire.pipe(
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.provideService(ProjectEnvironment, key.env),
      ),
    idleTimeToLive: SERVER_IDLE,
  });
  // Servers that did not start stay failed until the next root run starts
  // (`hold`): no step, and no subagent of the task, waits on a dead start
  // twice.
  const failed = new Set<ServerKey>();
  const holdServer: ProjectServers['holdServer'] = (plugin, load = '') =>
    Effect.gen(function* () {
      const key = new ServerKey(plugin, yield* ProjectEnvironment, load);
      const { tools, failure } = yield* RcMap.get(servers, key);
      if (failure !== undefined) failed.add(key);
      const revision = sha256({ spec: plugin.spec, env: plugin.revision });
      return { failure, tools, revision };
    });
  const hold: ProjectServers['hold'] = Effect.fn('ToolCatalog.hold')(
    function* (declared, root) {
      for (const key of root ? failed : []) {
        // Only a key whose entry still holds that failure: one started
        // healthily since is left running.
        const entry = yield* Effect.scoped(RcMap.getOption(servers, key));
        if (Option.isSome(entry) && entry.value.failure !== undefined)
          yield* RcMap.invalidate(servers, key);
        failed.delete(key);
      }
      const read = yield* loader(declared);
      const held = yield* Effect.forEach(
        read.plugins,
        (plugin) =>
          Effect.map(holdServer(plugin), (server) => ({
            id: plugin.id,
            ...server,
          })),
        { concurrency: 'unbounded' },
      );
      return { warnings: read.warnings, held };
    },
  );
  return { holdServer, hold } satisfies ProjectServers;
});
