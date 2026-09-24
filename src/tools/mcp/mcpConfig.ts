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
 * `mcp:<server>`; its spec (name, command, args and env names, never env
 * values) is what the run's composition records, so an edited entry is a
 * new composition and a new process beside the one open runs keep.
 *
 * An entry that does not validate is skipped with a warning the resolving
 * run shows in its transcript. The project-level `.texra/mcp.json` is not
 * read: a checked-in file that spawns processes needs a trust prompt first.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';
import stableStringify from 'safe-stable-stringify';
import { z } from 'zod';

import { TEXRA_STORAGE_DIR_NAME } from '@platform/defaults/nodeStorage';
import type { LoadedPlugin, PluginLoader } from '@tools/toolTable';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

import {
  acquireMcpServer,
  mcpPluginId,
  mcpServerOfToolName,
} from './mcpServer';

/** The user-level config file: `~/.texra/mcp.json`. */
export const USER_MCP_CONFIG_PATH = path.join(
  safeHomedir() ?? '/nonexistent',
  TEXRA_STORAGE_DIR_NAME,
  'mcp.json',
);

/**
 * A server name: the `<server>` in its tools' `mcp__<server>__<tool>` names,
 * so it takes their characters, stays short enough to leave room for a tool
 * name, and never contains the `__` separator.
 */
const ServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'use 1-32 letters, digits, _ or -')
  .refine((name) => !name.includes('__'), 'must not contain "__"');

const McpServerEntrySchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const McpConfigFileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

/** One configured stdio server, as the plugin spawns it. */
export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The file's text, or `null` when it does not exist. */
const readConfigText = (file: string) =>
  Effect.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: ensureError,
  }).pipe(
    Effect.map((text): string | null => text),
    Effect.catch((error) =>
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? Effect.succeed(null)
        : Effect.fail(
            new Error(`Could not read ${file}: ${toErrorMessage(error)}`),
          ),
    ),
  );

/** Parse the config file's servers, skipping each invalid entry loudly. */
function parseConfig(
  file: string,
  json: unknown,
): { servers: McpServerConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = McpConfigFileSchema.safeParse(json);
  if (!parsed.success)
    return {
      servers: [],
      warnings: [
        `${file} must be { "mcpServers": { ... } }: ${z.prettifyError(parsed.error)}`,
      ],
    };
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(parsed.data.mcpServers)) {
    const validName = ServerNameSchema.safeParse(name);
    const entry = McpServerEntrySchema.safeParse(raw);
    if (!validName.success || !entry.success) {
      const error = validName.error ?? entry.error;
      warnings.push(
        `MCP server "${name}" in ${file} is skipped (only stdio servers with a command are supported): ${error ? z.prettifyError(error) : ''}`,
      );
      continue;
    }
    servers.push({
      name,
      command: entry.data.command,
      args: entry.data.args ?? [],
      env: entry.data.env ?? {},
    });
  }
  return { servers, warnings };
}

/** The plugin one configured server is. */
function mcpPlugin(config: McpServerConfig): LoadedPlugin {
  return {
    id: mcpPluginId(config.name),
    spec: {
      name: config.name,
      command: config.command,
      args: [...config.args],
      envKeys: Object.keys(config.env).toSorted(),
    },
    revision: createHash('sha256')
      .update(stableStringify(config.env))
      .digest('hex'),
    acquire: acquireMcpServer(config),
  };
}

/** The loader over the MCP config file at `file`. */
export const mcpPluginLoader =
  (file: string): PluginLoader =>
  (declared) =>
    Effect.gen(function* () {
      const wanted = new Set(
        declared.flatMap((name) => mcpServerOfToolName(name) ?? []),
      );
      if (wanted.size === 0) return { plugins: [], warnings: [] };
      const text = yield* readConfigText(file);
      if (text === null)
        return {
          plugins: [],
          warnings: [
            `The run declares MCP tools, but ${file} does not exist; no MCP server is configured.`,
          ],
        };
      const json = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: (error) =>
          new Error(`${file} is not valid JSON: ${toErrorMessage(error)}`),
      });
      const { servers, warnings } = parseConfig(file, json);
      return {
        plugins: servers
          .filter((server) => wanted.has(server.name))
          .map(mcpPlugin),
        warnings,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ plugins: [], warnings: [error.message] }),
      ),
    );
