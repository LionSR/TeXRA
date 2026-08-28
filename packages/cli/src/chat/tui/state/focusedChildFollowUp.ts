import type { SessionStreamMetadata } from '@controllers/session/SessionState';
import {
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  isPlainAgentIdentity,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

import { activeStreamScope } from './streamViews';

export type FocusedChildFollowUpRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'accept'; readonly streamId: StreamTabId }
  | { readonly kind: 'reject'; readonly streamId: StreamTabId };

/** Select both the focused-child composer presentation and submission route.
 *  `metadata` is the active stream's shared metadata and `phaseOf` its
 *  lifecycle phase; callers read both (`streamMetadataFor(activeStreamId)`,
 *  `streamPhaseFor(streamId)`) so this selector stays pure. */
export function focusedChildFollowUpRoute(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly metadata: Readonly<SessionStreamMetadata> | undefined;
  readonly phaseOf: (streamId: StreamTabId) => StreamPhase | undefined;
}): FocusedChildFollowUpRoute {
  const scope = activeStreamScope({
    activeStreamId: init.activeStreamId,
    parentStream: init.parentStream,
  });
  if (scope.kind !== 'child') {
    return { kind: 'none' };
  }

  const status = init.phaseOf(scope.streamId);
  const metadata = init.metadata;
  // Terminal-backed agents consume follow-up queues at runtime, but the TUI
  // keeps their composer hidden until terminal-backed interaction has parity.
  const acceptsFollowUps =
    metadata?.userFollowUpSupport ===
      USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE &&
    isPlainAgentIdentity(metadata.identity) &&
    metadata.agentCategory === AgentCategory.ToolUse &&
    status !== undefined &&
    isInFlightPhase(status);
  if (acceptsFollowUps) {
    return { kind: 'accept', streamId: scope.streamId };
  }
  return { kind: 'reject', streamId: scope.streamId };
}
