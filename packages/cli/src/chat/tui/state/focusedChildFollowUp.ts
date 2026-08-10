import {
  AgentCategory,
  USER_FOLLOW_UP_SUPPORT,
  type StreamTabId,
} from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

import { activeStreamScope } from './streamViews';
import type { StreamSlice } from './cliState';

export type FocusedChildFollowUpRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'accept'; readonly streamId: StreamTabId }
  | { readonly kind: 'reject'; readonly streamId: StreamTabId };

/** Select both the focused-child composer presentation and submission route. */
export function focusedChildFollowUpRoute(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): FocusedChildFollowUpRoute {
  const scope = activeStreamScope({
    activeStreamId: init.activeStreamId,
    parentStream: init.parentStream,
  });
  if (scope.kind !== 'child') {
    return { kind: 'none' };
  }

  const slice = init.streams.get(scope.streamId);
  // Terminal-backed agents consume follow-up queues at runtime, but the TUI
  // keeps their composer hidden until terminal-backed interaction has parity.
  const acceptsFollowUps =
    slice?.userFollowUpSupport === USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE &&
    slice.identity?.kind === 'agent' &&
    slice.identity.tool === undefined &&
    slice.category === AgentCategory.ToolUse &&
    slice.status !== undefined &&
    isInFlightPhase(slice.status);
  if (acceptsFollowUps) {
    return { kind: 'accept', streamId: scope.streamId };
  }
  return { kind: 'reject', streamId: scope.streamId };
}
