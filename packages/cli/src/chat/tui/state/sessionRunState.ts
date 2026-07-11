import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { isActivePhase } from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

import { rootRunStartAvailable } from './cliState';

export interface ClearableTuiSessionState {
  streamId: StreamTabId | undefined;
  executionId: string | undefined;
  runtimeHost?: AgentRuntimeHost;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

export type TuiSession = ClearableTuiSessionState;

type InterruptibleTuiSessionState = Pick<
  ClearableTuiSessionState,
  'streamId' | 'runPromise' | 'runCompleted'
>;

type PendingTuiRunSessionState = Pick<
  ClearableTuiSessionState,
  'runPromise' | 'runCompleted'
>;

export function clearTuiSessionRunState(
  session: ClearableTuiSessionState,
): void {
  session.streamId = undefined;
  session.executionId = undefined;
  session.runtimeHost = undefined;
  session.runPromise = undefined;
  session.runExitCode = CliExitCode.Success;
  session.runCompleted = false;
  session.stopRequested = false;
  publishChatTuiRootRunStartAvailability(session);
}

export function markChatTuiRunPending(
  session: ClearableTuiSessionState,
  runPromise: Promise<void>,
  runtimeHost?: AgentRuntimeHost,
): void {
  session.streamId = undefined;
  session.runtimeHost = runtimeHost;
  session.runPromise = runPromise;
  session.runExitCode = CliExitCode.Success;
  session.runCompleted = false;
  session.stopRequested = false;
  publishChatTuiRootRunStartAvailability(session);
}

export function markChatTuiRunCompleted(
  session: PendingTuiRunSessionState,
): void {
  session.runCompleted = true;
  publishChatTuiRootRunStartAvailability(session);
}

/**
 * Atomically check-and-claim the root-run slot: fuses
 * {@link chatTuiCanStartRootRun} and {@link markChatTuiRunPending} into one
 * synchronous call so no caller can observe — or race on — a window between
 * the check and the claim. Every root-run entry point that awaits *before*
 * it would otherwise claim (resume, follow-up-wake resume) MUST call this as
 * its first statement, before any `await`, so the claim happens before the
 * caller can be suspended and a concurrent entry point can slip in and claim
 * the same slot. `startRootRun` claims via `markChatTuiRunPending` directly
 * instead — it never suspends before claiming, so it has no check-then-await
 * window for this primitive to close.
 */
export function tryClaimRootRunSlot(
  session: ClearableTuiSessionState,
  runPromise: Promise<void>,
  runtimeHost?: AgentRuntimeHost,
): boolean {
  if (!chatTuiCanStartRootRun(session)) return false;
  markChatTuiRunPending(session, runPromise, runtimeHost);
  return true;
}

export function chatTuiCanInterruptActiveRun(
  session: InterruptibleTuiSessionState,
): boolean {
  return Boolean(
    session.streamId && session.runPromise && !session.runCompleted,
  );
}

export function chatTuiCanStopActiveRun(
  session: InterruptibleTuiSessionState,
  status: StreamPhase | undefined,
): boolean {
  if (!session.runPromise || session.runCompleted) return false;
  if (!session.streamId) return true;
  return status === undefined || isActivePhase(status);
}

export function chatTuiCanStopVisibleRun(
  session: InterruptibleTuiSessionState,
  status: StreamPhase | undefined,
): boolean {
  return (
    chatTuiCanStopActiveRun(session, status) ||
    Boolean(session.streamId && isActivePhase(status))
  );
}

export function chatTuiCanStartRootRun(
  session: PendingTuiRunSessionState,
): boolean {
  return !session.runPromise || session.runCompleted;
}

export function publishChatTuiRootRunStartAvailability(
  session: PendingTuiRunSessionState,
): void {
  rootRunStartAvailable.set(chatTuiCanStartRootRun(session));
}

export function chatTuiCanSelectModel(input: {
  readonly canStartRootRun: boolean;
  readonly streamId: StreamTabId | undefined;
  readonly status: StreamPhase | undefined;
  readonly hasActiveToolUseFlow: boolean;
}): boolean {
  return (
    input.canStartRootRun ||
    Boolean(
      input.streamId &&
      input.status === STREAM_PHASE.WAITING &&
      input.hasActiveToolUseFlow,
    )
  );
}

export type ChatTuiSigintAction =
  'clean-exit' | 'force-exit' | 'preserve-exit' | 'interrupt-and-arm-exit';

export function chatTuiSigintAction(input: {
  readonly exitArmed: boolean;
  readonly canStopActiveRun: boolean;
  readonly resumableIdle: boolean;
}): ChatTuiSigintAction {
  if (input.exitArmed) return 'force-exit';
  if (input.canStopActiveRun) return 'interrupt-and-arm-exit';
  if (input.resumableIdle) return 'preserve-exit';
  return 'clean-exit';
}

/**
 * On exit, a tool-use session suspended at the WAIT node (idle/WAITING) with a
 * live flow must NOT be interrupted: interrupting clears its per-execution flow
 * record in `runToolUseFlow`'s finally, destroying the only resumable state.
 */
export function chatTuiIsResumableIdleOnExit(input: {
  readonly canInterruptActiveRun: boolean;
  readonly canStopActiveRun: boolean;
  readonly hasActiveToolUseFlow: boolean;
}): boolean {
  return (
    input.canInterruptActiveRun &&
    !input.canStopActiveRun &&
    input.hasActiveToolUseFlow
  );
}
