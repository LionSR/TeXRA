import { Effect } from 'effect';
import { z } from 'zod';

// Local imports - agent config
import { withLogChannel } from '@logger/effectLog';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { CodexReasoningEffort } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { executeCommand } from '@utils/system/execUtils';

// Type-only imports
import type { ModelReasoningEffort } from '@openai/codex-sdk';

// ============================================================================
// Model config — the Codex CLI uses short model names, not versioned API IDs
// ============================================================================

/** Short model name passed to the Codex CLI via --model. */
export const CODEX_CLI_MODEL = 'gpt-5.5';

const CHANNEL = 'codexConfig';
const codexXhighSupportByBinary = new Map<string, boolean>();
const codexXhighProbeLanes = new Map<string, PerKeyLane>();

// ============================================================================
// Reasoning effort
// ============================================================================

/**
 * Older Codex CLI runtimes reject `xhigh` even though it is present in the SDK
 * type. Preserve the requested level only after the resolved binary has been
 * checked; otherwise cap it to `high`.
 */
type CodexCliReasoningEffort = Extract<
  ModelReasoningEffort,
  'low' | 'medium' | 'high' | 'xhigh'
>;

export function toCodexCliReasoningEffort(
  effort: CodexReasoningEffort,
  supportsXhigh = false,
): CodexCliReasoningEffort {
  return effort === 'xhigh' && !supportsXhigh ? 'high' : effort;
}

/** The persisted effort, uncapped: a requested `xhigh` goes through
 *  `toCodexCliReasoningEffort` with the binary probe's answer. */
export const getCodexCliReasoningEffort = (
  stores: SettingsStores,
): Effect.Effect<CodexReasoningEffort, StateReadFailed> =>
  readSettingFrom<CodexReasoningEffort>(
    stores,
    WorkspaceStateKey.CODEX_REASONING_EFFORT,
  );

// ============================================================================
// Extra High capability probe
//
// `xhigh` is a level the resolved Codex runtime either reports or does not,
// so the effort above is only allowed to keep it once this probe says so.
// ============================================================================

type BundledCodexModel = {
  slug?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
};

/** Just the shape `catalogSupportsXhigh` depends on — a `models` array. Model
 *  entries stay `unknown` here and are duck-typed below, so one malformed
 *  entry elsewhere in the catalog can't take down a lookup for a model it
 *  doesn't concern. */
const BundledCodexCatalogSchema = z.object({
  models: z.array(z.unknown()),
});

const catalogSupportsXhigh = (
  stdout: string,
  model: string,
): Effect.Effect<boolean | undefined> =>
  Effect.try({
    try: (): unknown => JSON.parse(stdout),
    catch: () => undefined,
  }).pipe(
    Effect.map((parsed) => {
      const catalog = BundledCodexCatalogSchema.safeParse(parsed);
      if (!catalog.success) return undefined;
      const entry = catalog.data.models.find(
        (item): item is BundledCodexModel =>
          typeof item === 'object' &&
          item != null &&
          (item as BundledCodexModel).slug === model,
      );
      if (entry == null) return false;
      return (entry.supported_reasoning_levels ?? []).some(
        (level) => level.effort === 'xhigh',
      );
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const probeXhighSupport = Effect.fn('codexConfig.probeXhighSupport')(function* (
  binaryPath: string,
): Effect.fn.Return<boolean> {
  const cached = codexXhighSupportByBinary.get(binaryPath);
  if (cached != null) return cached;

  const result = yield* executeCommand(
    [binaryPath, 'debug', 'models', '--bundled'],
    // A capability probe of the binary itself: it runs no git command, and
    // this module holds no workspace whose identity it could carry.
    { quiet: true, timeout: 5_000, cwd: process.cwd(), settings: undefined },
  );
  if (result.timedOut || result.exitCode === 127) {
    yield* Effect.logWarning(
      'Codex xhigh capability probe failed; not caching the result',
    ).pipe(
      Effect.annotateLogs({
        data: {
          binaryPath,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      }),
      withLogChannel(CHANNEL),
    );
    return false;
  }
  if (!result.success) {
    codexXhighSupportByBinary.set(binaryPath, false);
    return false;
  }
  const supported = yield* catalogSupportsXhigh(result.stdout, CODEX_CLI_MODEL);
  if (supported == null) {
    yield* Effect.logWarning(
      'Codex xhigh capability probe returned unreadable catalog',
    ).pipe(
      Effect.annotateLogs({ data: { binaryPath } }),
      withLogChannel(CHANNEL),
    );
    return false;
  }
  codexXhighSupportByBinary.set(binaryPath, supported);
  return supported;
});

/**
 * Probe whether the resolved Codex runtime reports `xhigh` for the pinned
 * CLI model. Timeouts and spawn failures are not cached so a later call
 * retries instead of permanently capping Extra High to High.
 *
 * One lane per binary path: concurrent launches of the same binary queue
 * behind the first probe and read its cached answer instead of each spawning
 * their own five-second `codex debug models`.
 */
export const codexBinarySupportsXhigh = Effect.fn(
  'codexConfig.codexBinarySupportsXhigh',
)(function* (binaryPath: string | undefined): Effect.fn.Return<boolean> {
  if (!binaryPath) return false;
  return yield* probeXhighSupport(binaryPath).pipe(
    withPerKeyLane(codexXhighProbeLanes, binaryPath),
  );
});
