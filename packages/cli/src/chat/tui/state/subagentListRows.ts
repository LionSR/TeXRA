// Row model for the persistent SubagentList: sessions and active processes
// merged into one selectable list (one Select, one key map), replacing the
// picker's separate modal projection of the same data. Pure derivation —
// elapsed times and summaries resolve at render time from the row's source.

import type { ActiveChildInfo } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';

import { activeSubagentsFor, type ChildStreamEntries } from './childExecutions';
import type { StreamSlice } from './cliState';
import type { StreamView } from './streamViews';

export type SubagentListRow =
  | {
      readonly kind: 'session';
      readonly key: string;
      readonly session: StreamView;
      /** Execution id of the child run backing this stream, when killable. */
      readonly executionId?: string;
      readonly killable: boolean;
    }
  | {
      readonly kind: 'process';
      readonly key: string;
      readonly child: ActiveChildInfo;
      readonly killable: true;
    };

export function buildSubagentListRows({
  activeProcesses,
  childStreamEntries,
  parentStreamId,
  sessions,
  streams,
}: {
  readonly activeProcesses: readonly ActiveChildInfo[];
  readonly childStreamEntries: ChildStreamEntries;
  readonly parentStreamId: StreamTabId | undefined;
  readonly sessions: readonly StreamView[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): readonly SubagentListRow[] {
  const activeSubagents = parentStreamId
    ? activeSubagentsFor(parentStreamId, childStreamEntries, streams)
    : [];
  // An entry here means the stream is backed by a live child run — the same
  // membership the picker used to decide killability.
  const executionIdByStream = new Map<StreamTabId, string>(
    activeSubagents.map((child) => [child.childStreamId, child.executionId]),
  );

  return [
    ...sessions.map((session): SubagentListRow => {
      const executionId = executionIdByStream.get(session.id);
      return {
        kind: 'session',
        key: `session:${session.id}`,
        session,
        ...(executionId !== undefined ? { executionId } : {}),
        killable: executionId !== undefined,
      };
    }),
    ...activeProcesses.map((child): SubagentListRow => ({
      kind: 'process',
      key: `process:${child.executionId}`,
      child,
      killable: true,
    })),
  ];
}

export function subagentListRowStreamId(
  row: SubagentListRow,
): StreamTabId | undefined {
  return row.kind === 'session' ? row.session.id : undefined;
}
