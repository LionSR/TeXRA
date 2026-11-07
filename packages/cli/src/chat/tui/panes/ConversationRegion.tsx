// Conversation render boundary: static scrollback, live transcript, foreground
// surfaces, and queued follow-ups above the footer, with the compact side
// panels below it.

// Third-party imports
import { Number as Num } from 'effect';
import { Box } from 'ink';
import { useLayoutEffect, type ReactNode } from 'react';

// Local imports - shared constants and schemas
import { planOf, type RunId } from '@texra-ai/harness/schemas';
import { clampModalWidth } from '@cli/tui/ui/theme';

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
  QueuedFollowUpsPanel,
  queuedFollowUpPanelRowCount,
} from './QueuedFollowUpsPanel';
import { StaticConversationTranscript } from './StaticConversationTranscript';
import type { ChatScrollback } from './staticTranscriptRing';
import { SubagentList } from './SubagentList';
import { PlanPanel } from './PlanPanel';
import {
  inputBarContentRows,
  reverseSearchOpen as reverseSearchOpenSignal,
  rootRunId as rootRunIdSignal,
  selectedRunId as selectedRunIdSignal,
  sessionListRows,
  slashPaletteOpen as slashPaletteOpenSignal,
  childListFocused as childListFocusedSignal,
  focusChildList,
} from '../state/cliState';
import { sessionView, runViewOf } from '../state/sessionView';
import { useSignal } from '../state/useSignal';
import type { ForegroundSurfaceKind } from '../appInteractionPolicy';

// Cap the bottom subagent/plan panels so they never crowd out the
// conversation, even though they now render below the input bar.
const BOTTOM_PANEL_MAX_ROWS = 10;
/** The App-owned facts: its layout decisions. Everything else the region
 *  reads from its signals. */
interface ConversationRegionSnapshot {
  readonly foregroundMaxRows: number | undefined;
  readonly foregroundKind: ForegroundSurfaceKind | undefined;
}

interface ConversationRegionProps {
  readonly columns: number;
  readonly inputBarVisible: boolean;
  readonly renderForegroundSurface: (availableRows: number) => ReactNode;
  readonly renderFooterChrome: () => ReactNode;
  readonly rows: number;
  readonly scrollback: ChatScrollback;
  readonly snapshot: ConversationRegionSnapshot;
  readonly onFocusSession: (runId: RunId) => void;
  readonly onKillRun: (runId: RunId) => void;
}

export function ConversationRegion({
  columns,
  inputBarVisible,
  onFocusSession,
  onKillRun,
  renderFooterChrome,
  renderForegroundSurface,
  rows,
  scrollback,
  snapshot,
}: ConversationRegionProps): React.JSX.Element {
  const foregroundOpen = snapshot.foregroundKind !== undefined;
  const activeRunId = useSignal(selectedRunIdSignal);
  const rootRunId = useSignal(rootRunIdSignal);
  const reverseSearchOpen = useSignal(reverseSearchOpenSignal);
  const slashPaletteOpen = useSignal(slashPaletteOpenSignal);
  const sessionRows = useSignal(sessionListRows);
  const view = useSignal(sessionView());
  const childListFocused = useSignal(childListFocusedSignal);
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

  const activePlan = activeRun ? planOf(activeRun) : null;
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
    ? Num.clamp(requestedQueuedFollowUpPanelRows, {
        minimum: 0,
        maximum: Math.max(0, rows - footerRows),
      })
    : 0;
  const queuedFollowUpPanelVisible = queuedFollowUpPanelRows > 0;
  const aboveFooterRows = queuedFollowUpPanelRows;
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
    activePlan !== null && !foregroundOpen && !childListFocused ? 1 : 0;
  const {
    bottomPanelRows: bottomPanelBudget,
    conversationRows,
    sessionPanelRows: subagentRows,
    planRows,
  } = allocateConversationPanelRows({
    maxRows: BOTTOM_PANEL_MAX_ROWS,
    sessionCount: foregroundOpen ? 0 : sessionRows.length,
    childListFocused,
    planContentRows,
    transcriptRows,
  });
  const childListVisible = subagentRows > 0;
  // The list's rows are a layout fact: a focused list the layout leaves no
  // row for hands the keys back to the input.
  useLayoutEffect(() => {
    if (childListFocused && !foregroundOpen && !childListVisible) {
      focusChildList(false);
    }
  }, [childListVisible, foregroundOpen, childListFocused]);
  const foregroundSurface = renderForegroundSurface(foregroundRows);

  return (
    <>
      <StaticConversationTranscript
        maxRows={staticTranscriptRows}
        ownerKey={scrollbackTarget.ownerKey}
        scrollback={scrollback}
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
        {renderFooterChrome()}
        {bottomPanelBudget > 0 ? (
          <Box flexDirection="column" overflowY="hidden">
            <SubagentList
              keyboardActive={childListFocused && childListVisible}
              maxRows={subagentRows}
              onCancel={() => focusChildList(false)}
              onFocusRun={onFocusSession}
              onKillRun={onKillRun}
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
