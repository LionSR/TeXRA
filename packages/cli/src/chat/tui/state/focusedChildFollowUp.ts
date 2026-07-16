import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import type { StreamPhase, StreamTabId } from '@shared/schemas';
import { isInFlightPhase } from '@shared/streams/streamStatus';

import { activeStreamScope } from './streamViews';
import type { StreamSlice } from './cliState';

export type FocusedChildFollowUpRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'accept'; readonly streamId: StreamTabId }
  | { readonly kind: 'reject'; readonly streamId: StreamTabId };

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

  const status = init.streams.get(scope.streamId)?.status;
  // A focused child normally has a status. Keep the previous permissive
  // behavior during the brief edge where parent focus arrives first.
  if (status !== undefined && !isInFlightPhase(status)) {
    return { kind: 'reject', streamId: scope.streamId };
  }
  return { kind: 'accept', streamId: scope.streamId };
}

export function focusedChildInputDisabledMessage(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly shortcutModifierLabel?: string;
  readonly status: StreamPhase | undefined;
}): string | undefined {
  const scope = activeStreamScope({
    activeStreamId: init.activeStreamId,
    parentStream: init.parentStream,
  });
  if (
    scope.kind !== 'child' ||
    init.status === undefined ||
    isInFlightPhase(init.status)
  ) {
    return undefined;
  }
  const shortcutModifierLabel =
    init.shortcutModifierLabel ?? defaultShortcutModifierLabel();
  return (
    'Subagent is no longer accepting follow-ups; press Tab or ' +
    `${metaChordLabel(shortcutModifierLabel, 's')} to select a session.`
  );
}

export function stoppedFocusedChildFollowUpMessage(init: {
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  return (
    focusedChildInputDisabledMessage({
      activeStreamId: init.streamId,
      parentStream: init.parentStream,
      status: init.streams.get(init.streamId)?.status,
    }) ?? 'The selected subagent is no longer accepting follow-ups.'
  );
}
