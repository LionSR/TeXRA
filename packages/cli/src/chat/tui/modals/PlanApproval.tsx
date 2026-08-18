import { useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { COLOR_INFO } from '@cli/tui/ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
  isCompactRows,
} from '@cli/tui/ui/theme';
import { fillRows, truncateToWidth } from '@cli/runtime/terminalText';
import type { PlanApprovalPermission } from '@shared/schemas';
import { PLAN_GOAL_COPY } from '@shared/copy/delegationApproval';

import { ConfirmCard, CONFIRM_CARD_FEEDBACK_PLACEHOLDER } from './ConfirmCard';
import { confirmCardFeedbackRows } from './confirmCardRowsBudget';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import { confirmCardCompactChromeRows } from './ConfirmCardState';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly availableRows?: number;
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const COMPACT_PLAN_APPROVAL_MAX_ROWS = 7;
const PLAN_APPROVAL_TITLE = 'Approve plan?';
const PLAN_APPROVAL_GOAL_NOTICE_ROWS = 2;
const PLAN_APPROVAL_HIDDEN_NOUN = 'plan rows';
const PLAN_APPROVAL_GOAL_ACTION = {
  key: 'r',
  action: 'run as goal',
} as const;

export function isCompactPlanApprovalRows(
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

export function planApprovalGoalNoticeLine(width: number): string {
  const lineWidth = Math.max(1, width);
  return fillRows(
    truncateToWidth(PLAN_GOAL_COPY.cliNotice, lineWidth),
    lineWidth,
  );
}

export function planApprovalCompactBodyRowsBudget({
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
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState('');
  const { availableRows, onDecide, payload } = props;
  const { goalEnabled, plan } = payload;
  const compact = isCompactPlanApprovalRows(availableRows, goalEnabled);
  const contentWidth = clampModalWidth(
    compact ? columns : columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const compactBodyRows = compact
    ? planApprovalCompactBodyRowsBudget({
        availableRows,
        columns,
        goalEnabled,
      })
    : undefined;
  const goalActionVisible = isPlanApprovalGoalActionVisible({
    compact,
    goalEnabled,
    visibleBodyRows: compactBodyRows ?? 0,
  });
  const goalNoticeVisible = goalActionVisible && !feedbackMode;
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
          (feedbackMode
            ? confirmCardFeedbackRows({
                columns,
                placeholder: CONFIRM_CARD_FEEDBACK_PLACEHOLDER,
                value: feedbackValue,
              })
            : 0),
        title: PLAN_APPROVAL_TITLE,
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
                key: PLAN_APPROVAL_GOAL_ACTION.key,
                label: PLAN_APPROVAL_GOAL_ACTION.action,
                decision: {
                  accepted: true,
                  planAction: 'approve_and_goal',
                },
              },
            ]
          : []
      }
      feedbackPlaceholder={CONFIRM_CARD_FEEDBACK_PLACEHOLDER}
      onFeedbackModeChange={setFeedbackMode}
      onFeedbackValueChange={setFeedbackValue}
      onDecide={onDecide}
    >
      {compact && goalNoticeVisible && (
        <Text>{planApprovalGoalNoticeLine(contentWidth)}</Text>
      )}
      <ScrollableModalText
        hiddenNoun={PLAN_APPROVAL_HIDDEN_NOUN}
        marginWhenSpacious={!compact}
        maxRows={maxBodyRows}
        scrollActive={!feedbackMode}
        scrollHint="scroll plan"
        showScrollHints={!compact}
        text={plan.objective}
        trimWrappedLeadingWhitespace
        width={contentWidth}
      />
      {!compact && goalNoticeVisible && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text>{planApprovalGoalNoticeLine(contentWidth)}</Text>
        </Box>
      )}
    </ConfirmCard>
  );
}
