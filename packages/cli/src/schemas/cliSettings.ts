/**
 * CLI runtime settings.
 *
 * These fields are read from the CLI's `.texra/config.json` workspace
 * configuration to choose an agent, model, output format, etc. for each
 * `texra` command run. Shared keys used by CLI commands can also appear in
 * non-terminal hosts.
 *
 * The CLI parses values via hand-written Zod schemas inside
 * `packages/cli/src/runtime/cliConfig.ts`. This file exposes only the
 * shared enums and the top-level key list — the latter feeds the
 * "known TeXRA keys" set used for unknown-key warnings.
 */

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

/**
 * Top-level CLI setting keys (without the `texra.` prefix). Used to derive
 * the canonical "known CLI keys" set for unknown-key warnings.
 */
export const CLI_SETTING_PATHS = [
  'agent',
  'model',
  'outputFormat',
  'chat',
  'run',
] as const;
