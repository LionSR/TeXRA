/** Desktop-only presentation effects for session and runtime events. */

import type { SessionFact } from '@agent/runtime/SessionEventHub';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  type ProgressViewOutboundMessage,
  type RequestEnsureProgressViewPayload,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
  type SetActiveStreamPayload,
  type StreamTabId,
} from '@shared/schemas';
import { isGoalInFlight, type GoalStatus } from '@shared/schemas/goal';
import { GoalStore } from '@tools/goal';
import { assertNever } from '@utils/core';
import type { ProgressViewState } from '@controllers/progressView/backend/state/ProgressViewState';

export interface DesktopSessionProgressBridgeOptions {
  /** The owning bridge's progress-view state. */
  state: Pick<ProgressViewState, 'activeStream'>;
  /** Sends a progress-view outbound message to the renderer. */
  sendMessage: (message: ProgressViewOutboundMessage) => void;
  /** Routes the renderer to the progress view. */
  routeToProgress: () => void;
  /** Projects a goal-state change through the progress updater. */
  onGoalStateChanged: (
    streamId: StreamTabId,
    active: boolean,
    options?: { status?: GoalStatus; objective?: string },
  ) => void;
  /** Shows a desktop-owned error or instruction dialog. */
  onShowError: (message: string) => void;
}

export interface DesktopPresentationPayloads {
  requestEnsureProgressView: RequestEnsureProgressViewPayload;
  requestShowError: RequestShowErrorPayload;
  requestShowInstruction: RequestShowInstructionPayload;
}

type DesktopPresentationEvent = keyof DesktopPresentationPayloads;

export interface DesktopSessionProgressBridge {
  /** Handle a desktop-local presentation request from the runtime host. */
  handlePresentationEvent<K extends DesktopPresentationEvent>(
    event: K,
    payload: DesktopPresentationPayloads[K],
  ): void;
  /** Handle the desktop-only projection of a shared session fact. */
  handleSessionFact(fact: SessionFact): void;
  /** Ignore late events after the owning window closes. */
  dispose(): void;
}

class DesktopSessionProgressBridgeImpl implements DesktopSessionProgressBridge {
  private disposed = false;

  constructor(private readonly options: DesktopSessionProgressBridgeOptions) {}

  handlePresentationEvent<K extends DesktopPresentationEvent>(
    event: K,
    payload: DesktopPresentationPayloads[K],
  ): void {
    if (this.disposed) return;
    switch (event) {
      case 'requestEnsureProgressView':
        this.options.routeToProgress();
        return;
      case 'requestShowError':
      case 'requestShowInstruction':
        // No second dialog surface: fold the instruction into the same
        // error-dialog path `requestShowError` uses (one dialog per host).
        this.options.onShowError(
          (payload as RequestShowErrorPayload | RequestShowInstructionPayload)
            .message,
        );
        return;
    }
  }

  handleSessionFact(fact: SessionFact): void {
    if (this.disposed) return;
    switch (fact.type) {
      case 'setActiveStream':
        this.handleSetActiveStream(fact.payload);
        return;
      case 'goalStateChanged':
        this.handleGoalStateChanged(fact.payload.streamId);
        return;
      case 'updateStreamStatus':
      case 'updateStreamDescription':
      case 'setParentStream':
      case 'inquiryThreadUpdated':
      case 'clearMissingOutputs':
      case 'updateQueuedFollowUps':
      case 'followUpSent':
      case 'removeStream':
        return;
    }
    assertNever(fact, 'Unhandled desktop session fact');
  }

  dispose(): void {
    this.disposed = true;
  }

  private handleSetActiveStream(payload: SetActiveStreamPayload): void {
    if (!payload.streamId) {
      // The shared fact applier ignores an empty identifier, so desktop owns
      // the renderer clear for this host-local navigation case.
      this.options.state.activeStream = '';
      this.options.sendMessage({
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        activeStream: '',
      });
      return;
    }
    if (payload.suppressViewSwitch !== true) {
      this.options.routeToProgress();
    }
  }

  private handleGoalStateChanged(streamId: StreamTabId): void {
    const goal = GoalStore.getForStream(streamId);
    this.options.onGoalStateChanged(streamId, isGoalInFlight(goal), {
      status: goal?.status,
      objective: goal?.objective,
    });
  }
}

/** Create the desktop adapter for host-local presentation effects. */
export function createDesktopSessionProgressBridge(
  options: DesktopSessionProgressBridgeOptions,
): DesktopSessionProgressBridge {
  return new DesktopSessionProgressBridgeImpl(options);
}
