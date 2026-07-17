// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, and queued follow-ups above the footer, with the compact side
// panels below it.

// Third-party imports
import { Box } from 'ink';
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

// Local imports - shared constants and schemas
import { type StreamTabId } from '@shared/schemas';
import { clamp } from '@utils/core';

// Local imports - conversation panes and layout
import {
  allocateConversationBottomPanelRows,
  allocateMiddleRows,
  PINNED_CHROME_ROWS,
  shouldShowTodosPlanPanel,
  staticScrollbackTarget,
  staticTranscriptRowBudget,
} from '../appLayout';
import {
  isScopedTranscriptViewport,
  transcriptViewportChange,
  transcriptViewportKey,
  type TranscriptViewportChange,
} from '../state/transcriptViewportMode';
import { clampModalWidth } from '../ui/theme';
import { ConversationPane } from './ConversationPane';
import {
  QueuedFollowUpsPanel,
  queuedFollowUpPanelRowCount,
} from './QueuedFollowUpsPanel';
import { StaticConversationTranscript } from './StaticConversationTranscript';
import { SubagentList } from './SubagentList';
import { TodosPlanPanel, todosPlanPanelRowCount } from './TodosPlanPanel';
import type { ForegroundSurfaceKind } from '../appInteractionPolicy';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { ChildListTarget } from '../state/childControls';
import type { ChildListValue } from '../state/childListSelection';
import type { StreamSlice } from '../state/cliState';
import type { TranscriptPrintRequest } from '../state/transcriptLines';
import type { StreamView } from '../state/streamViews';

// Cap the bottom subagent/todos panels so they never crowd out the
// conversation, even though they now render below the input bar.
const BOTTOM_PANEL_MAX_ROWS = 10;
interface ConversationRegionSnapshot {
  readonly activeStreamId: StreamTabId | undefined;
  readonly foregroundMaxRows: number | undefined;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly reverseSearchOpen: boolean;
  readonly rootStreamId: StreamTabId | undefined;
  readonly slashPaletteOpen: boolean;
  readonly selectedChildValue: ChildListValue | undefined;
  readonly childListFocused: boolean;
  readonly sessionViews: readonly StreamView[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly activeSubagentExecutionIds: ReadonlyMap<StreamTabId, string>;
  readonly childListTarget: ChildListTarget;
  readonly pendingApprovals: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
  readonly transcriptPrints: readonly TranscriptPrintRequest[];
}

interface ConversationRegionProps {
  readonly colorEnabled?: boolean;
  readonly columns: number;
  readonly onTranscriptViewportChange?: (
    change: TranscriptViewportChange,
  ) => void;
  readonly renderForegroundSurface: (availableRows: number) => ReactNode;
  readonly renderFooterChrome: () => ReactNode;
  readonly rows: number;
  readonly snapshot: ConversationRegionSnapshot;
  readonly onCancelChildList: () => void;
  readonly onChildSelectionChange: (value: ChildListValue) => void;
  readonly onFocusSession: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly onOpenProcessDetail: (executionId: string) => void;
  readonly onPrintStream: (streamId: StreamTabId) => void;
}

export function ConversationRegion({
  colorEnabled,
  columns,
  onCancelChildList,
  onChildSelectionChange,
  onFocusSession,
  onKillExecution,
  onOpenProcessDetail,
  onPrintStream,
  onTranscriptViewportChange,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const foregroundOpen = snapshot.foregroundKind !== undefined;
  const inputBarVisible = !foregroundOpen;
  const viewportKey = transcriptViewportKey({
    activeStreamId: snapshot.activeStreamId,
    parentStream: snapshot.parentStream,
  });
  const scopedTranscript = isScopedTranscriptViewport(viewportKey);
  const ownerPrintRequests = useMemo(
    () =>
      snapshot.transcriptPrints.filter(
        (request) => request.ownerKey === viewportKey,
      ),
    [snapshot.transcriptPrints, viewportKey],
  );
  const scrollbackTarget = staticScrollbackTarget({
    activeStreamId: snapshot.activeStreamId,
    rootStreamId: snapshot.rootStreamId,
    scopedTranscript,
  });
  const previousViewportKey = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const previous = previousViewportKey.current;
    previousViewportKey.current = viewportKey;
    const change = transcriptViewportChange({
      previousViewportKey: previous,
      nextViewportKey: viewportKey,
    });
    if (change) onTranscriptViewportChange?.(change);
  }, [onTranscriptViewportChange, viewportKey]);

  const activeSlice = snapshot.activeStreamId
    ? snapshot.streams.get(snapshot.activeStreamId)
    : undefined;
  const queuedFollowUpMessages = activeSlice?.queuedFollowUpMessages ?? [];
  const queuedFollowUpPanelWanted =
    !foregroundOpen && queuedFollowUpMessages.length > 0;
  const footerRows =
    PINNED_CHROME_ROWS.status +
    (inputBarVisible ? PINNED_CHROME_ROWS.input : 0);
  const requestedQueuedFollowUpPanelRows = queuedFollowUpPanelWanted
    ? queuedFollowUpPanelRowCount(queuedFollowUpMessages)
    : 0;
  const queuedFollowUpPanelRows = queuedFollowUpPanelWanted
    ? clamp(rows - footerRows, 0, requestedQueuedFollowUpPanelRows)
    : 0;
  const queuedFollowUpPanelVisible = queuedFollowUpPanelRows > 0;
  const staticTranscriptRows = scopedTranscript
    ? undefined
    : staticTranscriptRowBudget({
        footerRows,
        foregroundOpen,
        queuedFollowUpPanelRows,
        rows,
      });
  const activeProcesses = snapshot.childListTarget.slice?.activeProcesses ?? [];
  const hasTodosPlanPanel = shouldShowTodosPlanPanel({
    foregroundOpen,
    hasPlan: activeSlice?.plan != null,
    status: activeSlice?.status,
    todos: activeSlice?.todos ?? [],
  });
  const transcriptWidth = clampModalWidth(columns);
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    foregroundMaxRows: snapshot.foregroundMaxRows,
    foregroundOpen,
    inputVisible: inputBarVisible,
    queuedFollowUpPanelRows,
    reverseSearchOpen: snapshot.reverseSearchOpen,
    rows,
    slashPaletteOpen: snapshot.slashPaletteOpen,
    staticTranscriptRows: staticTranscriptRows ?? 0,
  });
  // The subagent/todos panels live at the bottom of the same vertical column.
  // Reserve only as many rows as the panels actually need. Unfocused panels
  // use at most half the transcript, except for the one row needed to keep a
  // multi-child list visible in a short terminal.
  const todosPlanContentRows =
    hasTodosPlanPanel && activeSlice
      ? todosPlanPanelRowCount(activeSlice.todos, activeSlice.plan)
      : 0;
  const {
    bottomPanelRows: bottomPanelBudget,
    sessionPanelRows: subagentRows,
    todosPlanRows,
  } = allocateConversationBottomPanelRows({
    maxRows: BOTTOM_PANEL_MAX_ROWS,
    processCount: foregroundOpen ? 0 : activeProcesses.length,
    sessionCount: foregroundOpen ? 0 : snapshot.sessionViews.length,
    childListFocused: snapshot.childListFocused,
    todosPlanContentRows,
    transcriptRows,
  });
  const conversationRows = transcriptRows - bottomPanelBudget;
  const childListHasRows =
    snapshot.sessionViews.length > 0 || activeProcesses.length > 0;
  const childListVisible = childListHasRows && subagentRows > 1;
  useLayoutEffect(() => {
    if (snapshot.childListFocused && !foregroundOpen && !childListVisible) {
      onCancelChildList();
    }
  }, [
    childListVisible,
    foregroundOpen,
    onCancelChildList,
    snapshot.childListFocused,
  ]);
  const foregroundSurface = renderForegroundSurface(foregroundRows);

  return (
    <>
      <StaticConversationTranscript
        colorEnabled={colorEnabled}
        maxRows={staticTranscriptRows}
        ownerKey={scrollbackTarget.ownerKey}
        printRequests={ownerPrintRequests}
        scrollbackStreamId={scrollbackTarget.streamId}
        width={transcriptWidth}
      />
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {conversationRows > 0 ? (
            <ConversationPane
              colorEnabled={colorEnabled}
              width={transcriptWidth}
              maxRows={conversationRows}
            />
          ) : null}
          {foregroundSurface ? (
            // Cap the modal area at its row budget but size to the surface's
            // actual content. Each foreground surface already windows itself
            // to the budget, so a fixed height leaves dead rows below it.
            <Box
              flexDirection="column"
              maxHeight={foregroundRows}
              alignItems="flex-start"
              overflowY="hidden"
            >
              {foregroundSurface}
            </Box>
          ) : null}
        </Box>
        {queuedFollowUpPanelVisible ? (
          <QueuedFollowUpsPanel
            maxRows={queuedFollowUpPanelRows}
            messages={queuedFollowUpMessages}
            width={columns}
          />
        ) : null}
        {renderFooterChrome()}
        {bottomPanelBudget > 0 ? (
          <Box flexDirection="column" overflowY="hidden">
            <SubagentList
              keyboardActive={snapshot.childListFocused && childListVisible}
              maxRows={subagentRows}
              onCancel={onCancelChildList}
              onFocusStream={onFocusSession}
              onKillExecution={onKillExecution}
              onOpenProcessDetail={onOpenProcessDetail}
              onSelectionChange={onChildSelectionChange}
              onPrintStream={onPrintStream}
              pendingApprovals={snapshot.pendingApprovals}
              selectedValue={snapshot.selectedChildValue}
              sessions={snapshot.sessionViews}
              activeProcesses={activeProcesses}
              activeSubagentExecutionIds={snapshot.activeSubagentExecutionIds}
              processOutput={snapshot.childListTarget.slice?.processOutput}
            />
            <TodosPlanPanel maxRows={todosPlanRows} />
          </Box>
        ) : null}
      </Box>
    </>
  );
}
