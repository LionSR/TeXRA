import type { StreamTabId } from '@shared/schemas/identifiers';

/**
 * Context passed to every idle-continuation provider at wait-node entry,
 * before the wait-node would block on user input. Providers use it to
 * decide whether to synthesize a follow-up.
 */
export interface IdleContinuationContext {
  readonly streamId: StreamTabId;
  /** True when the wait-node is running inside an orchestrator-driven subagent. */
  readonly isSubagent: boolean;
  /** Snapshot of `session.hasQueuedFollowUp()` at the call site. */
  readonly hasQueuedFollowUp: boolean;
}

/**
 * One synthesized continuation. `commit()` is called by the wait-node AFTER
 * the post-await race re-check (`hasQueuedFollowUp` still false) passes —
 * never before — so providers should never record audit state in `build`.
 */
export interface IdleContinuation {
  readonly source: string;
  readonly followUp: string;
  commit(): Promise<void>;
}

/**
 * Feature provider hook. Returning `null` means "no continuation from me right
 * now" — the wait-node falls back to the next provider, then to a normal
 * blocking wait. Providers must be pure: side effects belong in `commit()`
 * so a losing race doesn't pollute persistent state.
 */
export interface IdleContinuationProvider {
  readonly source: string;
  build(ctx: IdleContinuationContext): Promise<IdleContinuation | null>;
}

const providers: IdleContinuationProvider[] = [];

export function registerIdleContinuation(
  provider: IdleContinuationProvider,
): void {
  if (providers.some((p) => p.source === provider.source)) {
    throw new Error(`Duplicate idle-continuation provider: ${provider.source}`);
  }
  providers.push(provider);
}

export function listIdleContinuationProviders(): readonly IdleContinuationProvider[] {
  return providers;
}

/** Test-only — clears the registry so suites don't leak across runs. */
export function __resetIdleContinuationRegistry(): void {
  providers.length = 0;
}
