// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, and queued follow-ups above the footer, with the compact side
// panels below it.

// Third-party imports
import { Box } from 'ink';
import { useLayoutEffect, type ReactNode } from 'react';

// Local imports - shared constants and schemas
import { clampModalWidth } from '@cli/tui/ui/theme';
import { interruptedTasks } from '@ui/copy/interruptedTasks';
import { clamp } from '@utils/core';

// Local imports - conversation panes and layout
import {
  allocateConversationPanelRows,
  allocateMiddleRows,
  PINNED_CHROME_ROWS,
  staticScrollbackTarget,
  staticTranscriptRowBudget,
} from '../appLayout';
import { ConversationPane } from './ConversationPane';
import {
  InterruptedTasksNotice,
  interruptedNoticeRowCount,
  NOTICE_MIN_ROWS,
} from './InterruptedTasksNotice';
import {
  QueuedFollowUpsPanel,
  queuedFollowUpPanelRowCount,
} from './QueuedFollowUpsPanel';
import { StaticConversationTranscript } from './StaticConversationTranscript';
import { SubagentList } from './SubagentList';
import { PlanPanel } from './PlanPanel';
import {
  inputBarContentRows,
  interruptedNoticeHidden as interruptedNoticeHiddenSignal,
  reverseSearchOpen as reverseSearchOpenSignal,
  rootRunId as rootRunIdSignal,
  selectedRunId as selectedRunIdSignal,
  sessionListRows,
  slashPaletteOpen as slashPaletteOpenSignal,
} from '../state/cliState';
import { sessionView, runViewOf } from '../state/sessionView';
import { staticTranscriptRepaintEpoch } from '../state/staticTranscriptRepaint';
import { useSignal } from '../state/useSignal';
import type { RunId } from '@texra-ai/harness/schemas';
import type { ForegroundSurfaceKind } from '../appInteractionPolicy';

// Cap the bottom subagent/plan panels so they never crowd out the
// conversation, even though they now render below the input bar.
const BOTTOM_PANEL_MAX_ROWS = 10;
/** The App-owned facts: its layout decisions and the child list's reducer
 *  state. Everything else the region reads from its signals. */
interface ConversationRegionSnapshot {
  readonly foregroundMaxRows: number | undefined;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
  readonly selectedChildValue: RunId | undefined;
  readonly childListFocused: boolean;
}

interface ConversationRegionProps {
  readonly columns: number;
  readonly inputBarVisible: boolean;
  readonly onStaticTranscriptChange?: () => void;
  readonly renderForegroundSurface: (availableRows: number) => ReactNode;
  readonly renderFooterChrome: () => ReactNode;
  readonly rows: number;
  readonly snapshot: ConversationRegionSnapshot;
  readonly onCancelChildList: () => void;
  readonly onChildSelectionChange: (value: RunId) => void;
  readonly onFocusSession: (runId: RunId) => void;
  readonly onKillRun: (runId: RunId) => void;
}

export function ConversationRegion({
  columns,
  inputBarVisible,
  onCancelChildList,
  onChildSelectionChange,
  onFocusSession,
  onKillRun,
  onStaticTranscriptChange,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const foregroundOpen = snapshot.foregroundKind !== undefined;
  const activeRunId = useSignal(selectedRunIdSignal);
  const rootRunId = useSignal(rootRunIdSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const sessionRows = useSignal(sessionListRows);
  const view = useSignal(sessionView());
  const activeRun = runViewOf(view, activeRunId);
  // Which scrollback the transcript paints: the root's history, or a focused
  // child's own history while that child owns the scrollback.
  const scopedTranscript =
    activeRunId !== undefined && activeRun?.parentId != null;
  const scrollbackTarget = staticScrollbackTarget({
    activeRunId,
    rootRunId,
    scopedTranscript,
  });
  const staticTranscriptRepaint = useSignal(staticTranscriptRepaintEpoch);
  const staticTranscriptKey = `${scrollbackTarget.ownerKey}:${staticTranscriptRepaint}`;

  const activePlan = activeRun?.plan ?? null;
  const queuedFollowUpMessages = (
    activeRunId === undefined
      ? []
      : (view.queuedFollowUps.get(activeRunId) ?? [])
  ).map((followUp) => followUp.text);
  const queuedFollowUpPanelWanted =
    !foregroundOpen && queuedFollowUpMessages.length > 0;
  // InputBar publishes the live content height so multi-line drafts shrink
  // the transcript instead of pushing pinned chrome off-screen.
  const inputRows =
    PINNED_CHROME_ROWS.inputBorder + useSignal(inputBarContentRows);
  const footerRows =
    PINNED_CHROME_ROWS.status + (inputBarVisible ? inputRows : 0);
  const requestedQueuedFollowUpPanelRows = queuedFollowUpPanelWanted
    ? queuedFollowUpPanelRowCount(queuedFollowUpMessages)
    : 0;
  const queuedFollowUpPanelRows = queuedFollowUpPanelWanted
    ? clamp(rows - footerRows, 0, requestedQueuedFollowUpPanelRows)
    : 0;
  const queuedFollowUpPanelVisible = queuedFollowUpPanelRows > 0;
  // The open-time notice shares the queued panel's place above the footer
  // and its share of the row budget.
  const noticeHidden = useSignal(interruptedNoticeHiddenSignal);
  const noticeTasks =
    noticeHidden || foregroundOpen ? [] : interruptedTasks(view);
  const noticeBudget = clamp(
    rows - footerRows - queuedFollowUpPanelRows,
    0,
    interruptedNoticeRowCount(noticeTasks),
  );
  const noticeRows = noticeBudget < NOTICE_MIN_ROWS ? 0 : noticeBudget;
  const aboveFooterRows = queuedFollowUpPanelRows + noticeRows;
  const staticTranscriptRows = scopedTranscript
    ? undefined
    : staticTranscriptRowBudget({
        footerRows,
        foregroundOpen,
        queuedFollowUpPanelRows: aboveFooterRows,
        rows,
      });
  const transcriptWidth = clampModalWidth(columns);
  const { foregroundRows, transcriptRows } = allocateMiddleRows({
    footerRows,
    foregroundMaxRows: snapshot.foregroundMaxRows,
    foregroundOpen,
    queuedFollowUpPanelRows: aboveFooterRows,
    reverseSearchOpen,
    rows,
    slashPaletteOpen,
    staticTranscriptRows: staticTranscriptRows ?? 0,
  });
  // One bottom panel at a time in the same vertical column: the child list
  // while it has focus, otherwise the plan panel's one summary row.
  const planContentRows =
    activePlan !== null && !foregroundOpen && !snapshot.childListFocused
      ? 1
      : 0;
  const {
    bottomPanelRows: bottomPanelBudget,
    conversationRows,
    sessionPanelRows: subagentRows,
    planRows,
  } = allocateConversationPanelRows({
    maxRows: BOTTOM_PANEL_MAX_ROWS,
    sessionCount: foregroundOpen ? 0 : sessionRows.length,
    childListFocused: snapshot.childListFocused,
    planContentRows,
    transcriptRows,
  });
  const childListVisible = subagentRows > 0;
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
        maxRows={staticTranscriptRows}
        ownerKey={scrollbackTarget.ownerKey}
        onRenderKeyChange={onStaticTranscriptChange}
        renderKey={staticTranscriptKey}
        scrollbackRunId={scrollbackTarget.runId}
        width={transcriptWidth}
      />
      <Box flexDirection="column">
        <Box flexDirection="column" overflowY="hidden">
          {conversationRows > 0 ? (
            <ConversationPane
              availableWidth={columns}
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
        {noticeRows > 0 ? (
          <InterruptedTasksNotice
            maxRows={noticeRows}
            tasks={noticeTasks}
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
              onFocusRun={onFocusSession}
              onKillRun={onKillRun}
              onSelectionChange={onChildSelectionChange}
              selectedValue={snapshot.selectedChildValue}
              rows={sessionRows}
              activeRunId={activeRunId}
            />
            <PlanPanel maxRows={planRows} plan={activePlan} />
          </Box>
        ) : null}
      </Box>
    </>
  );
}
