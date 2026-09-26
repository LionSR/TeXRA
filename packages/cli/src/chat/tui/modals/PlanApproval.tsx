import { useContext } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { COLOR_INFO } from '@cli/tui/ui/colors';
import {
  clampModalWidth,
  confirmCardContentWidth,
  isCompactRows,
} from '@cli/tui/ui/theme';
import { fillRows, truncateToWidth } from '@cli/runtime/terminalText';
import type { PlanApprovalPermission } from '@shared/schemas';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { PLAN_GOAL_COPY } from '@ui/copy/delegationApproval';

import { ConfirmCard, ConfirmCardFeedback } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import { confirmCardCompactChromeRows } from './ConfirmCardState';

interface PlanApprovalProps {
  readonly autoApproveAll: boolean;
  readonly availableRows?: number;
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

const COMPACT_PLAN_APPROVAL_MAX_ROWS = 7;
const PLAN_APPROVAL_TITLE = 'Approve plan?';
const PLAN_APPROVAL_GOAL_NOTICE_ROWS = 2;
const PLAN_APPROVAL_HIDDEN_NOUN = 'plan rows';
const PLAN_APPROVAL_GOAL_ACTION = {
  key: 'r',
  action: 'run as goal',
} as const;

function isCompactPlanApprovalRows(
  availableRows: number | undefined,
  goalEnabled = false,
): boolean {
  const compactMaxRows =
    COMPACT_PLAN_APPROVAL_MAX_ROWS +
    (goalEnabled ? PLAN_APPROVAL_GOAL_NOTICE_ROWS : 0);
  return (
    availableRows !== undefined &&
    availableRows > 0 &&
    isCompactRows(availableRows, compactMaxRows)
  );
}

export function planApprovalGoalNoticeLine(
  width: number,
  autoApproveAll = false,
): string {
  const lineWidth = Math.max(1, width);
  return fillRows(
    truncateToWidth(
      autoApproveAll
        ? PLAN_GOAL_COPY.cliAutoApproveAllNotice
        : PLAN_GOAL_COPY.cliNotice,
      lineWidth,
    ),
    lineWidth,
  );
}

function planApprovalCompactBodyRowsBudget({
  availableRows,
  columns,
  goalEnabled,
}: {
  readonly availableRows: number | undefined;
  readonly columns: number;
  readonly goalEnabled: boolean;
}): number | undefined {
  if (availableRows === undefined) return undefined;
  const chromeRows = confirmCardCompactChromeRows({
    title: PLAN_APPROVAL_TITLE,
    columns,
    extraActions: goalEnabled ? [PLAN_APPROVAL_GOAL_ACTION] : [],
  });
  return Math.max(0, availableRows - chromeRows);
}

export function isPlanApprovalGoalActionVisible({
  compact,
  goalEnabled,
  visibleBodyRows,
}: {
  readonly compact: boolean;
  readonly goalEnabled: boolean;
  readonly visibleBodyRows: number;
}): boolean {
  // Compact cards pin the notice above the body, so the action needs room
  // for the notice row plus at least one plan row.
  return goalEnabled && (!compact || visibleBodyRows > 1);
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const { autoApproveAll, availableRows, onDecide, payload } = props;
  const compact = isCompactPlanApprovalRows(availableRows, payload.goalEnabled);
  const compactBodyRows = compact
    ? planApprovalCompactBodyRowsBudget({
        availableRows,
        columns,
        goalEnabled: payload.goalEnabled,
      })
    : undefined;
  const goalActionVisible = isPlanApprovalGoalActionVisible({
    compact,
    goalEnabled: payload.goalEnabled,
    visibleBodyRows: compactBodyRows ?? 0,
  });

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_INFO}
      compact={compact}
      title={PLAN_APPROVAL_TITLE}
      rejectionMode="feedback"
      extraActions={
        goalActionVisible
          ? [
              {
                ...PLAN_APPROVAL_GOAL_ACTION,
                decision: {
                  action: 'approve_and_goal',
                  autoApproveAll: autoApproveAll ? true : null,
                },
              },
            ]
          : []
      }
      onDecide={onDecide}
    >
      <PlanApprovalBody
        autoApproveAll={autoApproveAll}
        availableRows={availableRows}
        compact={compact}
        compactBodyRows={compactBodyRows}
        goalActionVisible={goalActionVisible}
        objective={payload.plan.objective}
      />
    </ConfirmCard>
  );
}

function PlanApprovalBody({
  autoApproveAll,
  availableRows,
  compact,
  compactBodyRows,
  goalActionVisible,
  objective,
}: {
  readonly autoApproveAll: boolean;
  readonly availableRows?: number;
  readonly compact: boolean;
  readonly compactBodyRows: number | undefined;
  readonly goalActionVisible: boolean;
  readonly objective: string;
}): React.JSX.Element {
  const { columns } = useWindowSize();
  const feedback = useContext(ConfirmCardFeedback);
  const contentWidth = compact
    ? clampModalWidth(columns)
    : confirmCardContentWidth(columns);
  const goalNoticeVisible = goalActionVisible && !feedback.mode;
  // The notice is pinned outside the scroll region in both layouts so the
  // `r run as goal` action can never outlive its scope notice; in the
  // compact card it costs one body row.
  const maxBodyRows = compact
    ? Math.max(1, (compactBodyRows ?? 1) - (goalNoticeVisible ? 1 : 0))
    : scrollableModalTextRowsBudget({
        availableRows,
        columns,
        extraFixedRows:
          (goalNoticeVisible ? PLAN_APPROVAL_GOAL_NOTICE_ROWS : 0) +
          feedback.rows,
        title: PLAN_APPROVAL_TITLE,
      });

  return (
    <>
      {compact && goalNoticeVisible && (
        <Text>{planApprovalGoalNoticeLine(contentWidth, autoApproveAll)}</Text>
      )}
      <ScrollableModalText
        hiddenNoun={PLAN_APPROVAL_HIDDEN_NOUN}
        marginWhenSpacious={!compact}
        maxRows={maxBodyRows}
        scrollHint="scroll plan"
        showScrollHints={!compact}
        text={objective}
        trimWrappedLeadingWhitespace
        width={contentWidth}
      />
      {!compact && goalNoticeVisible && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text>
            {planApprovalGoalNoticeLine(contentWidth, autoApproveAll)}
          </Text>
        </Box>
      )}
    </>
  );
}
