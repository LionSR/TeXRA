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
  Schema,
  type Scope,
} from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { RuntimeTool } from '@agent/runtime/ToolServices';
import {
  envDigest,
  jsonSyntaxError,
  parseMcpServers,
  type McpServerConfig,
} from '@common/plugins/mcpServers';
import { ProjectEnvironment } from '@utils/system/nodeWorkspace';
import { sha256 } from '@utils/core/idHash';

import {
  acquireMcpServer,
  mcpPluginId,
  mcpServerOfToolName,
} from './mcpServer';

/** The config file's name inside the user's `~/.texra` directory. */
const MCP_CONFIG_FILE_NAME = 'mcp.json';

/** The user's MCP config file: `mcp.json` at a storage root. */
export function mcpConfigPathOf(storageRoot: string): string {
  return path.join(storageRoot, MCP_CONFIG_FILE_NAME);
}

const McpConfigFileSchema = Schema.Struct({
  mcpServers: Schema.Record(Schema.String, Schema.Unknown),
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
 * The config file's servers and the warnings its invalid entries raise, or
 * `null` when the file does not exist. An unreadable file, invalid JSON or a
 * wrong shape is one warning and no servers. The Plugins page lists them
 * read-only from here, and the CLI warns of a broken file at startup.
 */
export const readMcpConfig = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<ReturnType<typeof parseMcpServers> | null> =>
  Effect.gen(function* () {
    const text = yield* readConfigText(fs, file);
    if (text === null) return null;
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (error) =>
        new Error(`${file} is not valid JSON: ${jsonSyntaxError(error)}`),
    });
    const config = yield* Schema.decodeUnknownEffect(McpConfigFileSchema)(
      json,
    ).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `${file} must be { "mcpServers": { ... } }: ${error.message}`,
          ),
      ),
    );
    return parseMcpServers(file, config.mcpServers);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ servers: [], warnings: [error.message] }),
    ),
  );

/** What a server answers once up: its tools, or why none. */
export interface LoadedPluginTools {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  /** Why the server offers no tools (it failed to start). */
  readonly failure?: string;
}

/**
 * One MCP server as a plugin: its tools are known only once it is up, so a
 * run that names it holds its `spec` and revision in its project's catalog,
 * whose steps offer its tools while the run holds them.
 */
export interface McpServerPlugin {
  /** `mcp:<server>`, or the installed plugin's id. */
  readonly id: string;
  /** What the holds are counted by, with the revision. */
  readonly spec: Readonly<Record<string, unknown>>;
  /**
   * A keyed digest of the env values the spec leaves out: a changed
   * revision is a new process beside the open ones. Keyed per install, so it
   * reveals nothing about the values, and never recorded: an offered tool
   * records its spec's digest.
   */
  readonly revision: string;
  readonly config: McpServerConfig;
}

/** The configured servers a run's declared tool names reach, read fresh at
 *  each resolution, and the configuration problems the read found. */
export type PluginLoader = (declared: readonly string[]) => Effect.Effect<{
  readonly plugins: readonly McpServerPlugin[];
  readonly warnings: readonly string[];
}>;

/**
 * The plugin one server is, its env digested under `key`: a configured
 * server is its own plugin `mcp:<server>`; an installed plugin's servers go
 * under that plugin's `id`.
 */
export function mcpPlugin(
  config: McpServerConfig,
  key: string,
  id = mcpPluginId(config.name),
): McpServerPlugin {
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
    config,
  };
}

/** The loader over the MCP config file at `file`, read through `fs`, with
 *  env values digested under the key `revisionKey` reads,
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
  /** A server of `plugin` (of the installed plugin with trust digest `load`, if
   *  any) with the caller's project variables, for the caller's scope: its
   *  tools under its recorded revision, or why it has none. */
  readonly holdServer: (
    plugin: McpServerPlugin,
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
  readonly plugin: McpServerPlugin;
  readonly env: Readonly<Record<string, string>>;

  constructor(
    plugin: McpServerPlugin,
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
 *  idle closes sooner (its configured idle timeout), and a session's close
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
      acquireMcpServer(key.plugin.config).pipe(
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
