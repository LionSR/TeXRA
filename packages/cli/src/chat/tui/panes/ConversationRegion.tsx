// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, and queued follow-ups above the footer, with the compact side
// panels below it.

// Third-party imports
import { Box } from 'ink';
import { useLayoutEffect, useMemo, type ReactNode } from 'react';

// Local imports - shared constants and schemas
import { clampModalWidth } from '@cli/tui/ui/theme';
import type { StreamTabId, WorkflowControlAction } from '@shared/schemas';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { clamp } from '@utils/core';

// Local imports - conversation panes and layout
import {
  allocateConversationPanelRows,
  allocateMiddleRows,
  PINNED_CHROME_ROWS,
  shouldShowTodosPlanPanel,
  staticScrollbackTarget,
  staticTranscriptRowBudget,
} from '../appLayout';
import {
  isScopedTranscriptViewport,
  transcriptViewportKey,
} from '../state/transcriptViewportMode';
import { ConversationPane } from './ConversationPane';
import {
  QueuedFollowUpsPanel,
  queuedFollowUpPanelRowCount,
} from './QueuedFollowUpsPanel';
import { StaticConversationTranscript } from './StaticConversationTranscript';
import { SubagentList } from './SubagentList';
import { TodosPlanPanel, todosPlanPanelRowCount } from './TodosPlanPanel';
import { type ChildListValue } from '../state/childListSelection';
import { inputBarContentRows } from '../state/cliState';
import {
  workflowDashboardPanelItemCount,
  type WorkflowDashboardModel,
} from '../state/workflowDashboardModel';
import { useSignal } from '../state/useSignal';
import type { ForegroundSurfaceKind } from '../appInteractionPolicy';
import type { PendingApprovalKind } from '../state/approvalQueue';
import type { ChildListTarget } from '../state/childControls';
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
  readonly selectedChildValue: ChildListValue | undefined;
  /** Stream `selectedChildValue` points at, resolved once by `App`. */
  readonly selectedChildStreamId: StreamTabId | undefined;
  /** Dashboard rows for a workflow-script list root, derived once by `App`. */
  readonly workflowDashboard: WorkflowDashboardModel | undefined;
  readonly workflowDashboardRootHasApproval: boolean;
  readonly childListFocused: boolean;
  readonly sessionViews: readonly StreamView[];
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
  readonly subagentExecutionLabels: ExecutionLabels;
  readonly activeSubagentExecutionIds: ReadonlyMap<StreamTabId, string>;
  readonly childListTarget: ChildListTarget;
  readonly pendingApprovals: ReadonlyMap<
    string,
    readonly PendingApprovalKind[]
  >;
}

interface ConversationRegionProps {
  readonly colorEnabled?: boolean;
  readonly columns: number;
  readonly inputBarVisible: boolean;
  readonly onStaticTranscriptChange?: () => void;
  readonly renderForegroundSurface: (availableRows: number) => ReactNode;
  readonly renderFooterChrome: () => ReactNode;
  readonly rows: number;
  readonly snapshot: ConversationRegionSnapshot;
  readonly onCancelChildList: () => void;
  readonly onChildSelectionChange: (value: ChildListValue) => void;
  readonly onFocusSession: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
  readonly onWorkflowControl: (
    executionId: string,
    action: WorkflowControlAction,
  ) => void;
}

export function ConversationRegion({
  colorEnabled,
  columns,
  inputBarVisible,
  onCancelChildList,
  onChildSelectionChange,
  onFocusSession,
  onKillExecution,
  onWorkflowControl,
  onStaticTranscriptChange,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const foregroundOpen = snapshot.foregroundKind !== undefined;
  const viewportKey = transcriptViewportKey({
    activeStreamId: snapshot.activeStreamId,
    parentStream: snapshot.parentStream,
  });
  const scopedTranscript = isScopedTranscriptViewport(viewportKey);
  const scrollbackTarget = staticScrollbackTarget({
    activeStreamId: snapshot.activeStreamId,
    rootStreamId: snapshot.rootStreamId,
    scopedTranscript,
  });
  const executionLabelsKey = useMemo(
    () => JSON.stringify([...snapshot.subagentExecutionLabels]),
    [snapshot.subagentExecutionLabels],
  );
  const staticTranscriptKey = `${scrollbackTarget.ownerKey}:${executionLabelsKey}`;

  const activeSlice = snapshot.activeStreamId
    ? snapshot.streams.get(snapshot.activeStreamId)
    : undefined;
  const queuedFollowUpMessages = activeSlice?.queuedFollowUpMessages ?? [];
  const queuedFollowUpPanelWanted =
    !foregroundOpen && queuedFollowUpMessages.length > 0;
  // Round-border chrome is the default input height minus its single content
  // row; InputBar publishes the live content height so multi-line drafts shrink
  // the transcript instead of pushing pinned chrome off-screen.
  const inputBorderRows = PINNED_CHROME_ROWS.input - 1;
  const inputRows = inputBorderRows + useSignal(inputBarContentRows);
  const footerRows =
    PINNED_CHROME_ROWS.status + (inputBarVisible ? inputRows : 0);
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
  const hasTodosPlanPanel = shouldShowTodosPlanPanel({
    foregroundOpen,
    hasPlan: activeSlice?.plan != null,
    todos: activeSlice?.todos ?? [],
  });
  const transcriptWidth = clampModalWidth(columns);
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    foregroundMaxRows: snapshot.foregroundMaxRows,
    foregroundOpen,
    inputVisible: inputBarVisible,
    inputRows,
    queuedFollowUpPanelRows,
    reverseSearchOpen: snapshot.reverseSearchOpen,
    rows,
    slashPaletteOpen: snapshot.slashPaletteOpen,
    staticTranscriptRows: staticTranscriptRows ?? 0,
  });
  // The subagent/todos panels live at the bottom of the same vertical column.
  // Reserve only as many rows as the panels actually need. Child sessions stay
  // behind the status-bar navigation affordance until the list has focus, so a
  // background workflow cannot expand over the conversation by default.
  const todosPlanContentRows =
    hasTodosPlanPanel && activeSlice
      ? todosPlanPanelRowCount(activeSlice.todos, activeSlice.plan)
      : 0;
  const workflowDashboardItemCount = workflowDashboardPanelItemCount(
    snapshot.workflowDashboard,
    snapshot.selectedChildValue,
    snapshot.workflowDashboardRootHasApproval,
  );
  const sessionPanelItemCount =
    workflowDashboardItemCount > 0
      ? workflowDashboardItemCount
      : snapshot.sessionViews.length;
  const approvalOnlyDashboard =
    snapshot.workflowDashboardRootHasApproval &&
    workflowDashboardItemCount === 1;
  const minimumSessionPanelRows =
    workflowDashboardItemCount > 0 && !approvalOnlyDashboard ? 3 : 2;
  const {
    bottomPanelRows: bottomPanelBudget,
    conversationRows,
    sessionPanelRows: subagentRows,
    todosPlanRows,
  } = allocateConversationPanelRows({
    maxRows: BOTTOM_PANEL_MAX_ROWS,
    sessionCount: foregroundOpen ? 0 : sessionPanelItemCount,
    childListFocused: snapshot.childListFocused,
    minimumSessionPanelRows,
    todosPlanContentRows,
    transcriptRows,
  });
  const childListHasRows = sessionPanelItemCount > 0;
  const childListVisible =
    childListHasRows && subagentRows >= minimumSessionPanelRows;
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
        onRenderKeyChange={onStaticTranscriptChange}
        renderKey={staticTranscriptKey}
        scrollbackStreamId={scrollbackTarget.streamId}
        subagentExecutionLabels={snapshot.subagentExecutionLabels}
        width={transcriptWidth}
      />
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {conversationRows > 0 ? (
            <ConversationPane
              availableWidth={columns}
              colorEnabled={colorEnabled}
              width={transcriptWidth}
              maxRows={conversationRows}
              subagentExecutionLabels={snapshot.subagentExecutionLabels}
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
              onWorkflowControl={onWorkflowControl}
              onSelectionChange={onChildSelectionChange}
              pendingApprovals={snapshot.pendingApprovals}
              listRootStreamId={snapshot.childListTarget.streamId}
              dashboard={snapshot.workflowDashboard}
              selectedChildStreamId={snapshot.selectedChildStreamId}
              selectedValue={snapshot.selectedChildValue}
              sessions={snapshot.sessionViews}
              streams={snapshot.streams}
              activeSubagentExecutionIds={snapshot.activeSubagentExecutionIds}
            />
            <TodosPlanPanel maxRows={todosPlanRows} />
          </Box>
        ) : null}
      </Box>
    </>
  );
}
