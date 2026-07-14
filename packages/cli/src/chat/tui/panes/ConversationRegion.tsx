// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, compact side panels, tips, and queued follow-ups above the footer.

// Third-party imports
import { Box } from 'ink';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// Local imports - shared constants and schemas
import { type StreamTabId } from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';
import { clamp } from '@utils/core';

// Local imports - conversation panes and layout
import {
  allocateMiddleRows,
  allocateSidePanelRows,
  PINNED_CHROME_ROWS,
  shouldShowTipRow,
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
import { SubagentList, subagentPanelRowCount } from './SubagentList';
import { TipRow } from './TipRow';
import { TodosPlanPanel, todosPlanPanelRowCount } from './TodosPlanPanel';
import type { ForegroundSurfaceKind } from '../appInteractionPolicy';
import type { ChildControlStreamTarget } from '../state/childControls';
import type { StreamSlice } from '../state/cliState';
import type { StreamView } from '../state/streamViews';

// Cap the bottom subagent/todos panels so they never crowd out the
// conversation or push the input bar off-screen.
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
  readonly transcriptViewerStreamId: StreamTabId | undefined;
}

interface ConversationRegionProps {
  readonly agentSelectionAvailable: boolean;
  readonly colorEnabled?: boolean;
  readonly columns: number;
  readonly onTranscriptViewportChange?: (
    change: TranscriptViewportChange,
  ) => void;
  readonly renderForegroundSurface: (
    availableRows: number,
    transcriptWidth: number,
  ) => ReactNode;
  readonly renderFooterChrome: (
    queuedFollowUpPanelVisible: boolean,
  ) => ReactNode;
  readonly rows: number;
  readonly snapshot: ConversationRegionSnapshot;
  readonly onCancelSessionList: () => void;
  readonly onFocusSession: (streamId: StreamTabId) => void;
  readonly onSessionSelectionChange: (streamId: StreamTabId) => void;
}

export function ConversationRegion({
  agentSelectionAvailable,
  colorEnabled,
  columns,
  onCancelSessionList,
  onFocusSession,
  onSessionSelectionChange,
  onTranscriptViewportChange,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const [tipHour] = useState(() => new Date().getHours());
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
  const activeResponseRunning = isActivePhase(activeSlice?.status);
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
  const tipRowVisible =
    !scopedTranscript &&
    !snapshot.sessionListFocused &&
    shouldShowTipRow({
      foregroundOpen,
      hasQueuedFollowUps: queuedFollowUpPanelWanted,
    });
  const staticTranscriptRows = scopedTranscript
    ? undefined
    : staticTranscriptRowBudget({
        footerRows,
        foregroundOpen,
        queuedFollowUpPanelRows,
        rows,
        tipVisible: tipRowVisible,
      });
  const childExecutionPanelTarget = snapshot.childExecutionPanelTarget;
  const hasChildExecutionPanel =
    !foregroundOpen &&
    (snapshot.sessionViews.length > 0 ||
      (childExecutionPanelTarget.slice?.activeProcesses.length ?? 0) > 0);
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
    tipVisible: tipRowVisible,
  });
  // The subagent/todos panels live at the bottom of the same vertical column.
  // Reserve only as many rows as the panels actually need, capped so they
  // never take more than half the transcript or push the input off-screen.
  const subagentContentRows =
    hasChildExecutionPanel && childExecutionPanelTarget.slice
      ? subagentPanelRowCount(
          snapshot.sessionViews,
          childExecutionPanelTarget.slice.activeProcesses,
        )
      : 0;
  const todosPlanContentRows =
    hasTodosPlanPanel && activeSlice
      ? todosPlanPanelRowCount(activeSlice.todos, activeSlice.plan)
      : 0;
  const panelTranscriptLimit = snapshot.sessionListFocused
    ? transcriptRows
    : Math.floor(transcriptRows / 2);
  const bottomPanelBudget = Math.min(
    BOTTOM_PANEL_MAX_ROWS,
    subagentContentRows + todosPlanContentRows,
    panelTranscriptLimit,
  );
  const conversationRows = transcriptRows - bottomPanelBudget;
  const allocatedSidePanelRows = allocateSidePanelRows({
    subagentContentRows,
    todosPlanContentRows,
    rows: bottomPanelBudget,
  });
  const subagentRows =
    snapshot.sessionListFocused &&
    subagentContentRows > 0 &&
    bottomPanelBudget > 0
      ? Math.max(1, allocatedSidePanelRows.subagentRows)
      : allocatedSidePanelRows.subagentRows;
  const todosPlanRows = bottomPanelBudget - subagentRows;
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
        {bottomPanelBudget > 0 ? (
          <Box flexDirection="column" overflowY="hidden">
            <SubagentList
              keyboardActive={snapshot.sessionListFocused}
              maxRows={subagentRows}
              onCancel={onCancelSessionList}
              onFocusStream={onFocusSession}
              onSelectionChange={onSessionSelectionChange}
              selectedStreamId={snapshot.selectedSessionId}
              sessions={snapshot.sessionViews}
              activeProcesses={childExecutionPanelTarget.slice?.activeProcesses}
              processOutput={childExecutionPanelTarget.slice?.processOutput}
            />
            <TodosPlanPanel maxRows={todosPlanRows} />
          </Box>
        ) : null}
        {tipRowVisible ? (
          <TipRow
            agentSelectionAvailable={agentSelectionAvailable}
            hour={tipHour}
            responseRunning={activeResponseRunning}
          />
        ) : null}
        {queuedFollowUpPanelVisible ? (
          <QueuedFollowUpsPanel
            maxRows={queuedFollowUpPanelRows}
            messages={queuedFollowUpMessages}
            width={columns}
          />
        ) : null}
        {renderFooterChrome(queuedFollowUpPanelVisible)}
      </Box>
    </>
  );
}
