// Third-party imports
import { z } from 'zod';

/**
 * CLI runtime–only settings.
 *
 * These fields are read from the CLI's `.texra/config.json` workspace
 * configuration to choose an agent, model, output format, etc. for each
 * `texra` command run. They do not appear in the VS Code extension's
 * settings tree and are not meaningful to the Electron desktop host.
 *
 * The CLI today parses these via hand-written Zod schemas inside
 * `packages/cli/src/runtime/cliConfig.ts`. This file declares the same
 * shape in one canonical location so:
 *
 * 1. The "known TeXRA keys" set used for unknown-key warnings can be derived
 *    from a real schema instead of a string array.
 * 2. Future tooling (settings export, cross-host config sync) has a typed
 *    surface to operate on.
 *
 * Note on naming: the CLI's top-level `model` field (a string identifying
 * which AI model to use) intentionally does not collide with the core
 * `model.*` namespace (object with sub-fields like `useImprovedConnection`)
 * because the CLI stores its values in a flat JSON file under top-level keys
 * while the core `model.*` keys are namespace-prefixed.
 */

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];

const NonEmptyString = z.string().trim().min(1);

const CliCommandConfigSchema = z.strictObject({
  agent: NonEmptyString.optional(),
  model: NonEmptyString.optional(),
});

export const CliSettingsExtensionShape = {
  agent: NonEmptyString.optional(),
  model: NonEmptyString.optional(),
  outputFormat: z.enum(CLI_OUTPUT_FORMATS).optional(),
  approvalPolicy: z.enum(CLI_APPROVAL_POLICIES).optional(),
  chat: CliCommandConfigSchema.optional(),
  run: CliCommandConfigSchema.optional(),
};

export const CliSettingsExtensionSchema = z.strictObject(
  CliSettingsExtensionShape,
);

export type CliSettingsExtension = z.infer<typeof CliSettingsExtensionSchema>;

/**
 * Top-level CLI setting keys (without the `texra.` prefix). Used to derive
 * the canonical "known CLI keys" set for unknown-key warnings.
 */
export const CLI_SETTING_PATHS = [
  'agent',
  'model',
  'outputFormat',
  'approvalPolicy',
  'chat',
  'run',
] as const;

export type CliSettingPath = (typeof CLI_SETTING_PATHS)[number];
