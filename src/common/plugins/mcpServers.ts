/**
 * The `mcpServers` map of Claude's `.mcp.json` shape
 * (`{ "<name>": { "command", "args"?, "env"? } }`), stdio servers only: the
 * one reader of the user's `~/.texra/mcp.json` (`@tools/mcp/mcpConfig`) and
 * of the servers an installed plugin declares (`./pluginManifest`). An entry
 * that does not validate is skipped with a warning its reader reports.
 */
import { z } from 'zod';

/** One configured stdio server, as the MCP plugin spawns it. */
export interface McpServerConfig {
  /** The `<server>` in its tools' `mcp__<server>__<tool>` names. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The directory it runs in: an installed plugin's root. */
  readonly cwd?: string;
}

/**
 * A server name: the `<server>` in its tools' `mcp__<server>__<tool>` names,
 * so it takes their characters, stays short enough to leave room for a tool
 * name, and never contains the `__` separator.
 */
export const ServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'use 1-32 letters, digits, _ or -')
  .refine((name) => !name.includes('__'), 'must not contain "__"');

const McpServerEntrySchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * The servers of one `mcpServers` map read from `where`, and a warning for
 * each entry skipped: an invalid name, or anything but a stdio server with a
 * command.
 */
export function parseMcpServers(
  where: string,
  servers: Readonly<Record<string, unknown>>,
): { servers: McpServerConfig[]; warnings: string[] } {
  const parsed: McpServerConfig[] = [];
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const validName = ServerNameSchema.safeParse(name);
    const entry = McpServerEntrySchema.safeParse(raw);
    if (!validName.success || !entry.success) {
      const error = validName.error ?? entry.error;
      warnings.push(
        `MCP server "${name}" in ${where} is skipped (only stdio servers with a command are supported): ${error ? z.prettifyError(error) : ''}`,
      );
      continue;
    }
    parsed.push({
      name,
      command: entry.data.command,
      args: entry.data.args ?? [],
      env: entry.data.env ?? {},
    });
  }
  return { servers: parsed, warnings };
}
