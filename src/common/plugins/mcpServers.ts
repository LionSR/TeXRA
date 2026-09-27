/**
 * The `mcpServers` map of Claude's `.mcp.json` shape
 * (`{ "<name>": { "command", "args"?, "env"? } }`), stdio servers only: the
 * one reader of the user's `~/.texra/mcp.json` (`@tools/mcp/mcpConfig`) and
 * of the servers an installed plugin declares (`./pluginManifest`). An entry
 * that does not validate is skipped with a warning its reader reports.
 */
// Node imports
import { createHmac, randomBytes } from 'node:crypto';

// Third-party imports
import { Effect, Result } from 'effect';
import stableStringify from 'safe-stable-stringify';
import { z } from 'zod';

// Local imports - shared contracts
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';

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

/** A revision key as app state stores it: 32 random bytes, hex. */
const REVISION_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The key a server's env values are digested under: random per install,
 * created once in app state, never written to history. The same env values
 * digest the same across restarts, and a recorded digest cannot be checked
 * against a guessed value. A stored key is only read; an absent one is
 * created through one `modify` at the store's authority (create-if-absent,
 * so a concurrent creator's key wins). A stored value that is not a key is
 * replaced, loudly: every server then records a new revision once, and every
 * plugin with a server asks for trust again.
 */
export const revisionKey = (globalState: SettingsStores['globalState']) =>
  Effect.gen(function* () {
    const isKey = (value: unknown): value is string =>
      typeof value === 'string' && REVISION_KEY_PATTERN.test(value);
    const stored = yield* globalState.get<unknown>(
      GlobalStateKey.MCP_REVISION_KEY,
    );
    if (isKey(stored)) return stored;
    let replaced = false;
    const key = yield* globalState.modify(
      GlobalStateKey.MCP_REVISION_KEY,
      (current) => {
        if (isKey(current)) return Result.succeed(current);
        replaced = current !== undefined;
        return Result.succeed(randomBytes(32).toString('hex'));
      },
    );
    if (replaced)
      yield* Effect.logWarning(
        'The stored MCP revision key was not a key; a new one was created, so every MCP server records a new revision once.',
      );
    return key;
  });

/** A keyed digest of a server's env values, unreadable back to a value. */
export const envDigest = (key: string, env: Readonly<Record<string, string>>) =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update(stableStringify(env) ?? '')
    .digest('hex');

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
