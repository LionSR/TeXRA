import { Effect } from 'effect';
import { isFileNotFoundError } from '@common/errors';
import {
  decideRunModel,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import { TEXRA_CONFIG_FILE_NAME } from '@platform/defaults/nodeStorage';
import { isImplicitDefaultEligible } from '@shared/constants/agents';
import { isObject } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { GlobalStorageFS } from '@utils/files/storageFS';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  commandConfigModel,
  loadWorkspaceCliConfig,
  parseCliConfigValues,
  resolveConfiguredAgent,
  type CliConfigValues,
} from './cliConfig';
import { pickDefaultToolUseAgent } from './defaultAgents';
import { writeTextStderr } from './logSinks';

/**
 * A configured or environment agent value, trimmed and dropped if it can't be
 * the implicit default — so e.g. `simplifier` set as the chat agent in config
 * is ignored rather than auto-selected. An explicit `--agent` override bypasses
 * this and is honored as-is.
 */
function usableConfiguredAgent(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isImplicitDefaultEligible(trimmed) ? trimmed : undefined;
}

interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  readonly modelSource: ChatDefaultValueSource;
}

/** Chat default value sources are the shared run-model decision reasons. */
type ChatDefaultValueSource = Extract<
  RunModelDecisionReason,
  | 'explicit-override'
  | 'environment'
  | 'workspace-config'
  | 'user-config'
  | 'builtin-default'
>;

interface PartialDefaults {
  readonly agent?: string;
  readonly model?: string;
}

function defaultsFromConfigValues(values: CliConfigValues): PartialDefaults {
  return {
    agent: usableConfiguredAgent(resolveConfiguredAgent(values, 'chat')),
    model: commandConfigModel(values, 'chat'),
  };
}

/** Labels `loadUserDefaults`' warnings distinctly from the workspace file's
 *  (both are literally named `config.json`, just in different directories),
 *  matching the wording the read-failure branch already used. */
const USER_CONFIG_LABEL = `user config (${TEXRA_CONFIG_FILE_NAME})`;

/** `orchestrate`'s `launcher: while (true)` loop re-resolves chat defaults
 *  on every return to the launcher, so an in-scope invalid field (a typo'd
 *  texra.agent/texra.model/texra.chat.*) would otherwise reprint its warning
 *  once per loop pass for as long as the session stays open. Deduped against
 *  only the *previous* call's warnings (not every warning ever seen this
 *  process): the message text carries just the field name, not the invalid
 *  value, so a field a user fixes and later breaks again the same way would
 *  otherwise never warn again if this stayed a monotonically-growing set. */
let previousUserConfigWarnings = new Set<string>();

/** Test-only: this module-level dedup state otherwise leaks across `it()`
 *  blocks in the same file (Vitest doesn't reset module state between tests
 *  by default), which would make one test's warnings spuriously suppress
 *  another's. Call from a `beforeEach` in any suite that asserts on
 *  `loadUserDefaults`/`resolveChatDefaults` warnings. */
export function __resetUserConfigWarningDedupeForTests(): void {
  previousUserConfigWarnings = new Set();
}

const loadUserDefaults = Effect.fn(function* (
  quiet: boolean,
): Effect.fn.Return<PartialDefaults> {
  // A missing user config means no user defaults (parseCliConfigValues maps
  // the undefined fallback to {}). A read failure — corrupt JSON, a
  // permission error — a top-level shape that isn't an object, and an
  // invalid individual field still drop the affected default(s), but now
  // with a warning instead of silence, mirroring loadWorkspaceCliConfig's
  // handling of the same failure classes for the workspace config. Unknown-
  // key warnings are suppressed: this file is
  // shared by all three hosts and holds rows the CLI does not honor (same
  // reasoning as loadUserApprovalPolicy). `quiet` mirrors --quiet: every
  // other config warning is gated by contextFromArgs on context.quietLogs
  // before this function ever runs, so these warnings honor the same flag
  // instead of always printing.
  const thisCallsWarnings = new Set<string>();
  const warn = (message: string): void => {
    thisCallsWarnings.add(message);
    if (quiet) return;
    if (previousUserConfigWarnings.has(message)) return;
    writeTextStderr(`WARN ${message}`);
  };
  let raw: unknown = yield* Effect.tryPromise({
    try: () => GlobalStorageFS.readJson(TEXRA_CONFIG_FILE_NAME),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (!isFileNotFoundError(error)) {
          warn(`Could not read ${USER_CONFIG_LABEL}: ${toErrorMessage(error)}`);
        }
        return undefined;
      }),
    ),
  );
  if (raw !== undefined && !isObject(raw)) {
    warn(`Ignoring ${USER_CONFIG_LABEL}; expected a JSON object.`);
    raw = undefined;
  }
  const { values, warnings } = parseCliConfigValues(raw, USER_CONFIG_LABEL, {
    reportUnknownKeys: false,
    // defaultsFromConfigValues only reads agent/model (top-level and
    // chat.*) — scoping to just those fields avoids re-validating
    // approvalPolicy (already warned about by loadUserApprovalPolicy) and
    // outputFormat/run.* (unused here). Scoping alone doesn't stop an
    // in-scope invalid field from reprinting every launcher-loop pass —
    // that's what `previousUserConfigWarnings` is for, above.
    topLevelFields: new Set(['agent', 'model']),
    sections: new Set(['chat']),
  });
  for (const warning of warnings) warn(warning);
  previousUserConfigWarnings = thisCallsWarnings;
  return defaultsFromConfigValues(values);
});

interface ResolveChatDefaultsInit {
  readonly cwd: string;
  readonly agentOverride?: string;
  readonly modelOverride?: string;
  readonly envAgent?: string;
  readonly envModel?: string;
  readonly visibleToolUseAgents?: readonly { readonly name: string }[];
  /** Suppresses the user-config warnings `loadUserDefaults` would otherwise
   *  print directly — pass `context.quietLogs` so this tier's warnings
   *  respect `--quiet` the same way `contextFromArgs` gates every other
   *  config warning. */
  readonly quiet?: boolean;
}

/**
 * Three-tier lookup per `.agents/docs/archived/feature/2026-05-14-cli-tui-ink/2026-05-14-10-architecture.md#entrypoint-default`:
 * workspace `.texra/config.json` → user `<global-storage>/config.json` →
 * built-in. Per-field independence: a workspace that only sets `agent` still
 * falls through to the user config for `model`.
 */
export const resolveChatDefaults = Effect.fn(function* (
  init: ResolveChatDefaultsInit,
): Effect.fn.Return<ChatDefaults, Error> {
  const overrideAgent = init.agentOverride?.trim();
  const overrideModel = init.modelOverride?.trim();
  const envAgent = usableConfiguredAgent(init.envAgent);
  const envModel = init.envModel?.trim();
  let agent = overrideAgent || envAgent;
  const directModel = overrideModel || envModel;
  const skipDefaultTierIo = Boolean(agent && directModel);

  let workspace: PartialDefaults = {};
  let user: PartialDefaults = {};

  if (!skipDefaultTierIo) {
    // Tiers are independent I/O — fan out in parallel.
    // Workspace defaults use the same .texra/config.json reader as the CLI
    // context so startup does not depend on platform initialization.
    [workspace, user] = yield* Effect.all(
      [
        loadWorkspaceCliConfig(init.cwd).pipe(
          Effect.map((loaded) => defaultsFromConfigValues(loaded.values)),
        ),
        loadUserDefaults(init.quiet ?? false),
      ],
      { concurrency: 'unbounded' },
    );
    // The order below is the per-field fallthrough.
    for (const defaults of [workspace, user]) {
      if (!agent && defaults.agent) agent = defaults.agent;
    }
  }

  const modelDecision = decideRunModel([
    { model: overrideModel, reason: 'explicit-override' },
    { model: envModel, reason: 'environment' },
    { model: workspace.model, reason: 'workspace-config' },
    { model: user.model, reason: 'user-config' },
    { model: CLI_BUILTIN_DEFAULT_MODEL, reason: 'builtin-default' },
  ]);

  const model = modelDecision?.model;
  // The candidate list above only uses reasons in ChatDefaultValueSource.
  const modelSource = modelDecision?.reason as
    ChatDefaultValueSource | undefined;
  return {
    agent: agent ?? pickDefaultToolUseAgent(init.visibleToolUseAgents),
    model: model ?? CLI_BUILTIN_DEFAULT_MODEL,
    modelSource: modelSource ?? 'builtin-default',
  };
});
