import { isInFlightStatus } from '@common/constants/streamStatus';
import type { StreamStatus, StreamTabId } from '@shared/schemas';

import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '../shortcutLabels';

import { resolveChildControlDisplayTargets } from './childControls';
import type { StreamSlice } from './cliState';
import { activeStreamScope } from './streamViews';

export type FocusedChildFollowUpRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'accept'; readonly streamId: StreamTabId }
  | { readonly kind: 'reject'; readonly streamId: StreamTabId };

export function focusedChildFollowUpRoute(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly statusForStream: (streamId: StreamTabId) => StreamStatus | undefined;
}): FocusedChildFollowUpRoute {
  const scope = activeStreamScope({
    activeStreamId: init.activeStreamId,
    parentStream: init.parentStream,
  });
  if (scope.kind !== 'child') {
    return { kind: 'none' };
  }

  const status = init.statusForStream(scope.streamId);
  // A focused child normally has a status. Keep the previous permissive
  // behavior during the brief edge where parent focus arrives first.
  if (status !== undefined && !isInFlightStatus(status)) {
    return { kind: 'reject', streamId: scope.streamId };
  }
  return { kind: 'accept', streamId: scope.streamId };
}

export function focusedChildInputDisabledMessage(init: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly shortcutModifierLabel?: string;
  readonly status: StreamStatus | undefined;
  readonly subagentControlsAvailable?: boolean;
  readonly taskControlsAvailable?: boolean;
}): string | undefined {
  const scope = activeStreamScope({
    activeStreamId: init.activeStreamId,
    parentStream: init.parentStream,
  });
  if (
    scope.kind !== 'child' ||
    init.status === undefined ||
    isInFlightStatus(init.status)
  ) {
    return undefined;
  }
  const shortcutModifierLabel =
    init.shortcutModifierLabel ?? defaultShortcutModifierLabel();
  const alternateActions: string[] = [];
  if (init.subagentControlsAvailable !== false) {
    alternateActions.push(
      `${metaChordLabel(shortcutModifierLabel, 's')} to choose another`,
    );
  }
  if (init.taskControlsAvailable === true) {
    alternateActions.push(
      `${metaChordLabel(shortcutModifierLabel, 'p')} to review tasks`,
    );
  }
  const base =
    'Subagent is no longer accepting follow-ups; press Tab to switch streams';
  if (alternateActions.length === 0) return `${base}.`;
  const alternateText = alternateActions.join(', or ');
  return `${base} or ${alternateText}.`;
}

export function stoppedFocusedChildFollowUpMessage(init: {
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly status: StreamStatus | undefined;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  const controls = resolveChildControlDisplayTargets({
    activeStreamId: init.streamId,
    parentStream: init.parentStream,
    streams: init.streams,
  });

  return (
    focusedChildInputDisabledMessage({
      activeStreamId: init.streamId,
      parentStream: init.parentStream,
      status: init.status,
      subagentControlsAvailable: controls.subagents.hasItems,
      taskControlsAvailable: controls.tasks.hasItems,
    }) ?? 'The selected subagent is no longer accepting follow-ups.'
  );
}
