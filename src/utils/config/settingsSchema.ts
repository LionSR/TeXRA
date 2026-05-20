// ---------------------------------------------------------------------------
// Known `texra.*` configuration keys
// ---------------------------------------------------------------------------
//
// Authoritative list of canonical `texra.*` setting keys recognized by the
// extension and the CLI for "unknown key" detection.
//
// Two sources contribute:
//
// 1. The VS Code-facing settings tree (`TEXRA_SETTING_KEYS`) — derived from
//    `TexraSettingsSchema`, which is composed of {@link CoreSettingsSchema}
//    plus VS Code-only extensions.
// 2. The CLI runtime fields (`CLI_SETTING_PATHS`) — declared in
//    `@shared/schemas/settings/cliSettings`. These are top-level CLI-only
//    keys like `agent`, `model`, `outputFormat`, etc.

import { CLI_SETTING_PATHS } from '@shared/schemas/settings/cliSettings';
import { TEXRA_SETTING_KEYS } from '@shared/schemas/settingsConfiguration';

// Re-export CLI enums from the canonical location so existing call sites
// (`from '@utils/config/settingsSchema'`) keep working.
export {
  CLI_APPROVAL_POLICIES,
  CLI_OUTPUT_FORMATS,
  type CliApprovalPolicy,
  type CliOutputFormat,
} from '@shared/schemas/settings/cliSettings';

const CLI_RUNTIME_KEYS = CLI_SETTING_PATHS.map((path) => `texra.${path}`);

/** Set of all known canonical `texra.*` config keys. */
export const KNOWN_TEXRA_KEYS: ReadonlySet<string> = new Set<string>([
  ...TEXRA_SETTING_KEYS,
  ...CLI_RUNTIME_KEYS,
]);
