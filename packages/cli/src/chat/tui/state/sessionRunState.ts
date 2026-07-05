import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { isLiveElapsedStatus } from '@common/constants/streamStatus';
import {
  STREAM_STATUS,
  type StreamLifecycleStatus,
  type StreamTabId,
} from '@shared/schemas';

import { rootRunStartAvailable } from './cliState/focusSlice';

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

export function chatTuiCanInterruptActiveRun(
  session: InterruptibleTuiSessionState,
): boolean {
  return Boolean(
    session.streamId && session.runPromise && !session.runCompleted,
  );
}

export function chatTuiCanStopActiveRun(
  session: InterruptibleTuiSessionState,
  status: StreamLifecycleStatus | undefined,
): boolean {
  if (!session.runPromise || session.runCompleted) return false;
  if (!session.streamId) return true;
  return status === undefined || isLiveElapsedStatus(status);
}

export function chatTuiCanStopVisibleRun(
  session: InterruptibleTuiSessionState,
  status: StreamLifecycleStatus | undefined,
): boolean {
  return (
    chatTuiCanStopActiveRun(session, status) ||
    Boolean(session.streamId && isLiveElapsedStatus(status))
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
  readonly status: StreamLifecycleStatus | undefined;
  readonly hasActiveToolUseFlow: boolean;
}): boolean {
  return (
    input.canStartRootRun ||
    Boolean(
      input.streamId &&
      input.status === STREAM_STATUS.WAITING &&
      input.hasActiveToolUseFlow,
    )
  );
}

export type ChatTuiSigintAction =
  'clean-exit' | 'force-exit' | 'preserve-exit' | 'interrupt-and-arm-exit';

export function chatTuiSigintAction(input: {
  readonly exitArmed: boolean;
  readonly canStopActiveRun: boolean;
  readonly canInterruptActiveRun: boolean;
}): ChatTuiSigintAction {
  if (input.exitArmed) return 'force-exit';
  if (input.canStopActiveRun) return 'interrupt-and-arm-exit';
  // Resumable-idle (interruptible, not actively running): exit WITHOUT
  // interrupting so the suspended tool-use flow record survives for resume.
  if (input.canInterruptActiveRun) return 'preserve-exit';
  return 'clean-exit';
}

/**
 * On exit, a tool-use session suspended at the WAIT node (idle/WAITING) must
 * NOT be interrupted: interrupting clears its per-execution flow record in
 * `runToolUseFlow`'s finally, destroying the only resumable state.
 */
export function chatTuiIsResumableIdleOnExit(input: {
  readonly canInterruptActiveRun: boolean;
  readonly canStopActiveRun: boolean;
}): boolean {
  return input.canInterruptActiveRun && !input.canStopActiveRun;
}
