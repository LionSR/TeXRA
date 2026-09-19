import { z } from 'zod';

// Local imports - agent config
import { createLog } from '@logger/logUtils';
import type { StateStore } from '@platform/interfaces';
import type { CodexReasoningEffort } from '@shared/schemas';
import {
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { executeCommand } from '@utils/system/execUtils';

import { createEnumStateGetter } from './support/enumConfig';

// Type-only imports
import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
} from '@openai/codex-sdk';

// ============================================================================
// Model config — the Codex CLI uses short model names, not versioned API IDs
// ============================================================================

/** Short model name passed to the Codex CLI via --model. */
export const CODEX_CLI_MODEL = 'gpt-5.5';

const log = createLog('codexConfig');
const codexXhighSupportByBinary = new Map<string, boolean>();
const codexXhighProbes = new Map<string, Promise<boolean>>();

// ============================================================================
// Reasoning effort
// ============================================================================

const getCodexReasoningEffort = createEnumStateGetter(
  WorkspaceStateKey.CODEX_REASONING_EFFORT,
  CODEX_REASONING_EFFORT_DEFAULT,
  parseCodexReasoningEffort,
);

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

export function getCodexCliReasoningEffort(
  workspaceState: StateStore,
  supportsXhigh = false,
): CodexCliReasoningEffort {
  return toCodexCliReasoningEffort(
    getCodexReasoningEffort(workspaceState),
    supportsXhigh,
  );
}

// ============================================================================
// Approval policy
// ============================================================================

// The schema in `@shared` is the single source of truth for the persisted
// values; the SDK-typed return annotation is what keeps those values aligned
// with the Codex union — a schema value the SDK doesn't accept fails here.
export const getCodexApprovalPolicy: (
  workspaceState: StateStore,
) => ApprovalMode = createEnumStateGetter(
  WorkspaceStateKey.CODEX_APPROVAL_POLICY,
  CODEX_APPROVAL_POLICY_DEFAULT,
  parseCodexApprovalPolicy,
);

// ============================================================================
// Sandbox mode
// ============================================================================

// As above: the SDK-typed return annotation is the alignment guard between the
// persisted schema values and the Codex sandbox union.
export const getCodexSandboxMode: (workspaceState: StateStore) => SandboxMode =
  createEnumStateGetter(
    WorkspaceStateKey.CODEX_SANDBOX_MODE,
    CODEX_SANDBOX_MODE_DEFAULT,
    parseCodexSandboxMode,
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

function catalogSupportsXhigh(
  stdout: string,
  model: string,
): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
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
  } catch {
    return undefined;
  }
}

/**
 * Probe whether the resolved Codex runtime reports `xhigh` for the pinned
 * CLI model. Timeouts and spawn failures are not cached so a later call
 * retries instead of permanently capping Extra High to High.
 */
export async function codexBinarySupportsXhigh(
  binaryPath: string | undefined,
): Promise<boolean> {
  if (!binaryPath) return false;

  const cached = codexXhighSupportByBinary.get(binaryPath);
  if (cached != null) return cached;

  const inflight = codexXhighProbes.get(binaryPath);
  if (inflight) return inflight;

  const probe = (async (): Promise<boolean> => {
    const result = await executeCommand(
      [binaryPath, 'debug', 'models', '--bundled'],
      // A capability probe of the binary itself: it runs no git command, and
      // this module holds no workspace whose identity it could carry.
      { quiet: true, timeout: 5_000, cwd: process.cwd(), settings: undefined },
    );
    if (result.timedOut || result.exitCode === 127) {
      log.warn('Codex xhigh capability probe failed; not caching the result', {
        data: {
          binaryPath,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      });
      return false;
    }
    if (!result.success) {
      codexXhighSupportByBinary.set(binaryPath, false);
      return false;
    }
    const supported = catalogSupportsXhigh(result.stdout, CODEX_CLI_MODEL);
    if (supported == null) {
      log.warn('Codex xhigh capability probe returned unreadable catalog', {
        data: { binaryPath },
      });
      return false;
    }
    codexXhighSupportByBinary.set(binaryPath, supported);
    return supported;
  })().finally(() => {
    codexXhighProbes.delete(binaryPath);
  });

  codexXhighProbes.set(binaryPath, probe);
  return probe;
}
