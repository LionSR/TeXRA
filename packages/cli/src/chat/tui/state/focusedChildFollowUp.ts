import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import { isInFlightPhase } from '@shared/streams/streamStatus';
import type { StreamPhase, StreamTabId } from '@shared/schemas';

import { resolveChildControlDisplayTargets } from './childControls';
import { activeStreamScope } from './streamViews';
import type { ChildStreamEntries } from './childExecutions';
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
    isInFlightPhase(init.status)
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
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streamId: StreamTabId;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): string {
  const controls = resolveChildControlDisplayTargets({
    activeStreamId: init.streamId,
    childStreamEntries: init.childStreamEntries,
    parentStream: init.parentStream,
    streams: init.streams,
  });

  return (
    focusedChildInputDisabledMessage({
      activeStreamId: init.streamId,
      parentStream: init.parentStream,
      status: init.streams.get(init.streamId)?.status,
      subagentControlsAvailable: controls.subagents.hasItems,
      taskControlsAvailable: controls.tasks.hasItems,
    }) ?? 'The selected subagent is no longer accepting follow-ups.'
  );
}
