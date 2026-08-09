import type { StreamTabId } from '@shared/schemas';
import { streamAcceptsFollowUps } from '@shared/streams/followUpCapability';

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
  if (slice && streamAcceptsFollowUps(slice)) {
    return { kind: 'accept', streamId: scope.streamId };
  }
  return { kind: 'reject', streamId: scope.streamId };
}
