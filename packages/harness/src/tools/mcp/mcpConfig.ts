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
 * An entry that does not validate is skipped with a warning the resolving
 * run shows in its transcript. The project-level `.texra/mcp.json` is not
 * read: a checked-in file that spawns processes needs a trust prompt first.
 */
import * as path from 'node:path';

import { Effect, type FileSystem } from 'effect';
import { z } from 'zod';

import {
  envDigest,
  parseMcpServers,
  type McpServerConfig,
} from '@common/plugins/mcpServers';
import { TEXRA_STORAGE_DIR_NAME } from '@platform/defaults/nodeStorage';
import type { LoadedPlugin, PluginLoader } from '@tools/toolTable';
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
