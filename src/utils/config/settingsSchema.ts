// ---------------------------------------------------------------------------
// CLI-specific enums
// ---------------------------------------------------------------------------

export const CLI_OUTPUT_FORMATS = ['text', 'json', 'ndjson'] as const;
export type CliOutputFormat = (typeof CLI_OUTPUT_FORMATS)[number];

export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];

// ---------------------------------------------------------------------------
// Known `texra.*` configuration keys
// ---------------------------------------------------------------------------
//
// Authoritative list of canonical `texra.*` setting keys recognized by the
// extension and the CLI for "unknown key" detection. The structured per-key
// schemas and defaults are the canonical source (`TEXRA_SETTING_KEYS` from
// `@shared/schemas/settingsConfiguration`); CLI-runtime-only keys are
// appended here so they can also pass validation.

import { TEXRA_SETTING_KEYS } from '@shared/schemas/settingsConfiguration';

// CLI-only top-level keys (no structured schema; consumed by CLI runtime).
const CLI_RUNTIME_KEYS = [
  'texra.agent',
  'texra.model',
  'texra.outputFormat',
  'texra.approvalPolicy',
  'texra.chat',
  'texra.run',
] as const;

/** Set of all known canonical `texra.*` config keys. */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...TEXRA_SETTING_KEYS,
  ...CLI_RUNTIME_KEYS,
]);
