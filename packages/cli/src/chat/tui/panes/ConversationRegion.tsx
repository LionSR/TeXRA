// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, and queued follow-ups above the footer, with the compact side
// panels below it.

// Third-party imports
import { Box } from 'ink';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

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
import type { ChildControlStreamTarget } from '../state/childControls';
import type { SubagentListRow } from '../state/subagentListRows';
import type { StreamSlice } from '../state/cliState';
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
  readonly selectedSessionId: StreamTabId | undefined;
  readonly sessionListFocused: boolean;
  readonly sessionViews: readonly StreamView[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly childExecutionPanelTarget: ChildControlStreamTarget;
  readonly subagentListRows: readonly SubagentListRow[];
  readonly transcriptViewerStreamId: StreamTabId | undefined;
}

interface ConversationRegionProps {
  readonly colorEnabled?: boolean;
  readonly columns: number;
  readonly onTranscriptViewportChange?: (
    change: TranscriptViewportChange,
  ) => void;
  readonly renderForegroundSurface: (
    availableRows: number,
    transcriptWidth: number,
  ) => ReactNode;
  readonly renderFooterChrome: () => ReactNode;
  readonly rows: number;
  readonly snapshot: ConversationRegionSnapshot;
  readonly onCancelSessionList: () => void;
  readonly onFocusSession: (streamId: StreamTabId) => void;
  readonly onKillExecution?: (executionId: string) => void;
  readonly onOpenTaskDetail: (executionId: string) => void;
  readonly onSessionSelectionChange: (streamId: StreamTabId) => void;
}

export function ConversationRegion({
  colorEnabled,
  columns,
  onCancelSessionList,
  onFocusSession,
  onKillExecution,
  onOpenTaskDetail,
  onSessionSelectionChange,
  onTranscriptViewportChange,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const transcriptViewerOpen = snapshot.transcriptViewerStreamId !== undefined;
  const foregroundOpen = snapshot.foregroundKind !== undefined;
  const inputBarVisible = !foregroundOpen;
  const viewportKey = transcriptViewportKey({
    activeStreamId: snapshot.activeStreamId,
    parentStream: snapshot.parentStream,
    transcriptViewerStreamId: snapshot.transcriptViewerStreamId,
  });
  const scopedTranscript = isScopedTranscriptViewport(viewportKey);
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
  const childExecutionPanelTarget = snapshot.childExecutionPanelTarget;
  const activeProcesses =
    childExecutionPanelTarget.slice?.activeProcesses ?? [];
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
    reserveTranscriptRows: snapshot.foregroundKind !== 'transcript',
    rows,
    slashPaletteOpen: snapshot.slashPaletteOpen,
    staticTranscriptRows: staticTranscriptRows ?? 0,
  });
  // The subagent/todos panels live at the bottom of the same vertical column.
  // Reserve only as many rows as the panels actually need. Unfocused panels
  // use at most half the transcript, except for the one row needed to keep a
  // multi-session list visible in a short terminal.
  const todosPlanContentRows =
    hasTodosPlanPanel && activeSlice
      ? todosPlanPanelRowCount(activeSlice.todos, activeSlice.plan)
      : 0;
  const {
    bottomPanelRows: bottomPanelBudget,
    sessionPanelRows: subagentRows,
    spacerRows,
    todosPlanRows,
  } = allocateConversationBottomPanelRows({
    maxRows: BOTTOM_PANEL_MAX_ROWS,
    processCount: foregroundOpen ? 0 : activeProcesses.length,
    sessionCount: foregroundOpen ? 0 : snapshot.sessionViews.length,
    sessionListFocused: snapshot.sessionListFocused,
    todosPlanContentRows,
    transcriptRows,
  });
  const conversationRows = transcriptRows - bottomPanelBudget;
  const sessionListVisible =
    snapshot.sessionViews.length > 0 && subagentRows > 0;
  useLayoutEffect(() => {
    if (snapshot.sessionListFocused && !sessionListVisible) {
      onCancelSessionList();
    }
  }, [onCancelSessionList, sessionListVisible, snapshot.sessionListFocused]);
  const foregroundSurface = renderForegroundSurface(
    foregroundRows,
    transcriptWidth,
  );

  return (
    <>
      {transcriptViewerOpen ? null : (
        <StaticConversationTranscript
          colorEnabled={colorEnabled}
          maxRows={staticTranscriptRows}
          ownerKey={scrollbackTarget.ownerKey}
          scrollbackStreamId={scrollbackTarget.streamId}
          width={transcriptWidth}
        />
      )}
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {!transcriptViewerOpen && conversationRows > 0 ? (
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
            {spacerRows > 0 ? <Box height={spacerRows} /> : null}
            <SubagentList
              keyboardActive={snapshot.sessionListFocused && sessionListVisible}
              maxRows={subagentRows}
              onCancel={onCancelSessionList}
              onFocusStream={onFocusSession}
              onKillExecution={onKillExecution}
              onOpenTaskDetail={onOpenTaskDetail}
              onSelectionChange={onSessionSelectionChange}
              processOutput={childExecutionPanelTarget.slice?.processOutput}
              rows={snapshot.subagentListRows}
              selectedStreamId={snapshot.selectedSessionId}
            />
            <TodosPlanPanel maxRows={todosPlanRows} />
          </Box>
        ) : null}
      </Box>
    </>
  );
}
