// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, and queued follow-ups above the footer, with the compact side
// panels below it.

// Third-party imports
import { Box } from 'ink';
import { useLayoutEffect, type ReactNode } from 'react';

// Local imports - shared constants and schemas
import { clampModalWidth } from '@cli/tui/ui/theme';
import type { StreamTabId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
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
import { activeTranscriptViewport } from '../state/transcriptViewportMode';
import { ConversationPane } from './ConversationPane';
import {
  QueuedFollowUpsPanel,
  queuedFollowUpPanelRowCount,
} from './QueuedFollowUpsPanel';
import { StaticConversationTranscript } from './StaticConversationTranscript';
import { SubagentList } from './SubagentList';
import { TodosPlanPanel, todosPlanPanelRowCount } from './TodosPlanPanel';
import { inputBarContentRows } from '../state/cliState';
import { sessionView, streamViewOf } from '../state/sessionView';
import { staticTranscriptRepaintEpoch } from '../state/staticTranscriptRepaint';
import { useSignal } from '../state/useSignal';
import type { ForegroundSurfaceKind } from '../appInteractionPolicy';
import type { PendingApprovalKind } from '../state/approvalQueue';

// Cap the bottom subagent/todos panels so they never crowd out the
// conversation, even though they now render below the input bar.
const BOTTOM_PANEL_MAX_ROWS = 10;
interface ConversationRegionSnapshot {
  readonly activeStreamId: StreamTabId | undefined;
  readonly foregroundMaxRows: number | undefined;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
  /** The active stream's parent, when it is a child. */
  readonly parentId: StreamTabId | undefined;
  readonly reverseSearchOpen: boolean;
  readonly rootStreamId: StreamTabId | undefined;
  readonly slashPaletteOpen: boolean;
  readonly selectedChildValue: StreamTabId | undefined;
  readonly childListFocused: boolean;
  /** The child-list rows: the list root, then its descendants newest first. */
  readonly sessions: readonly StreamTabId[];
  readonly subagentExecutionLabels: ExecutionLabels;
  readonly listRootStreamId: StreamTabId | undefined;
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
  readonly onChildSelectionChange: (value: StreamTabId) => void;
  readonly onFocusSession: (streamId: StreamTabId) => void;
  readonly onKillExecution: (executionId: string) => void;
}

export function ConversationRegion({
  colorEnabled,
  columns,
  inputBarVisible,
  onCancelChildList,
  onChildSelectionChange,
  onFocusSession,
  onKillExecution,
  onStaticTranscriptChange,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const foregroundOpen = snapshot.foregroundKind !== undefined;
  const { key: viewportKey, scoped: scopedTranscript } =
    activeTranscriptViewport({
      activeStreamId: snapshot.activeStreamId,
      parentId: snapshot.parentId,
    });
  const scrollbackTarget = staticScrollbackTarget({
    activeStreamId: snapshot.activeStreamId,
    rootStreamId: snapshot.rootStreamId,
    scopedTranscript,
  });
  const staticTranscriptRepaint = useSignal(staticTranscriptRepaintEpoch);
  const staticTranscriptKey = `${scrollbackTarget.ownerKey}:${staticTranscriptRepaint}`;

  const view = useSignal(sessionView());
  const activeStream = streamViewOf(view, snapshot.activeStreamId);
  const activeTodos =
    activeStream?.category === AgentCategory.ToolUse ? activeStream.todos : [];
  const activePlan =
    activeStream?.category === AgentCategory.ToolUse ? activeStream.plan : null;
  const queuedFollowUpMessages =
    snapshot.activeStreamId === undefined
      ? []
      : (view.queuedFollowUps.get(snapshot.activeStreamId) ?? []);
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
    childListFocused: snapshot.childListFocused,
    foregroundOpen,
    hasPlan: activePlan != null,
    todos: activeTodos,
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
  // One bottom panel at a time in the same vertical column: the child list
  // while it has focus, otherwise the todos/plan panel. Reserve only as many
  // rows as that panel actually needs.
  const todosPlanContentRows =
    hasTodosPlanPanel && activeStream
      ? todosPlanPanelRowCount(activeTodos, activePlan)
      : 0;
  const sessionPanelItemCount = snapshot.sessions.length;
  const minimumSessionPanelRows = 2;
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
              onSelectionChange={onChildSelectionChange}
              pendingApprovals={snapshot.pendingApprovals}
              listRootStreamId={snapshot.listRootStreamId}
              selectedValue={snapshot.selectedChildValue}
              sessions={snapshot.sessions}
            />
            <TodosPlanPanel
              maxRows={todosPlanRows}
              plan={activePlan}
              todos={activeTodos}
            />
          </Box>
        ) : null}
      </Box>
    </>
  );
}
