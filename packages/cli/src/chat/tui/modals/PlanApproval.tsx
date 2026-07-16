import { useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { PlanApprovalPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import { COLOR_INFO } from '../ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '../ui/theme';
import { confirmCardCompactChromeRows } from './ConfirmCardState';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { fillRows, truncateToWidth } from '../render/terminalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly availableRows?: number;
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export const COMPACT_PLAN_APPROVAL_MAX_ROWS = 7;
const PLAN_APPROVAL_TITLE = 'Approve plan?';
export const PLAN_APPROVAL_GOAL_NOTICE =
  'Approve & run only auto-approves bash.';
const PLAN_APPROVAL_GOAL_NOTICE_ROWS = 2;
const PLAN_APPROVAL_FEEDBACK_MARGIN_ROWS = 1;
const PLAN_APPROVAL_FEEDBACK_PREFIX_COLUMNS = 2;
const PLAN_APPROVAL_FEEDBACK_PLACEHOLDER = 'Feedback to send with rejection';
const PLAN_APPROVAL_HIDDEN_NOUN = 'plan rows';
const PLAN_APPROVAL_GOAL_ACTION = {
  key: 'r',
  action: 'approve & run',
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
    availableRows <= compactMaxRows
  );
}

export function planApprovalGoalNoticeLine(width: number): string {
  const lineWidth = Math.max(1, width);
  return fillRows(
    truncateToWidth(PLAN_APPROVAL_GOAL_NOTICE, lineWidth),
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

export function planApprovalFeedbackRows({
  columns,
  placeholder = PLAN_APPROVAL_FEEDBACK_PLACEHOLDER,
  value,
}: {
  readonly columns: number;
  readonly placeholder?: string;
  readonly value: string;
}): number {
  const text = value.length > 0 ? value : placeholder;
  const width = Math.max(
    1,
    columns -
      CONFIRM_CARD_HORIZONTAL_DECORATION -
      PLAN_APPROVAL_FEEDBACK_PREFIX_COLUMNS,
  );
  return (
    PLAN_APPROVAL_FEEDBACK_MARGIN_ROWS +
    Math.max(1, wrapAnsiToWidth(text, width).split('\n').length)
  );
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
  const goalEnabled = props.payload.goalEnabled;
  const compact = isCompactPlanApprovalRows(props.availableRows, goalEnabled);
  const contentWidth = clampModalWidth(
    compact ? columns : columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const compactBodyRows = compact
    ? planApprovalCompactBodyRowsBudget({
        availableRows: props.availableRows,
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
  // `r approve & run` action can never outlive its scope warning; in the
  // compact card it costs one body row.
  const maxBodyRows = compact
    ? Math.max(1, (compactBodyRows ?? 1) - (goalNoticeVisible ? 1 : 0))
    : scrollableModalTextRowsBudget({
        availableRows: props.availableRows,
        columns,
        extraFixedRows:
          (goalNoticeVisible ? PLAN_APPROVAL_GOAL_NOTICE_ROWS : 0) +
          (feedbackMode
            ? planApprovalFeedbackRows({ columns, value: feedbackValue })
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
      feedbackPlaceholder={PLAN_APPROVAL_FEEDBACK_PLACEHOLDER}
      onFeedbackModeChange={setFeedbackMode}
      onFeedbackValueChange={setFeedbackValue}
      onDecide={props.onDecide}
    >
      {compact && goalNoticeVisible ? (
        <Text>{planApprovalGoalNoticeLine(contentWidth)}</Text>
      ) : null}
      <ScrollableModalText
        hiddenNoun={PLAN_APPROVAL_HIDDEN_NOUN}
        marginWhenSpacious={!compact}
        maxRows={maxBodyRows}
        scrollActive={!feedbackMode}
        scrollHint="scroll plan"
        showScrollHints={!compact}
        text={props.payload.plan.objective}
        trimWrappedLeadingWhitespace
        width={contentWidth}
      />
      {!compact && goalNoticeVisible ? (
        <Box flexDirection="column">
          <Text> </Text>
          <Text>{planApprovalGoalNoticeLine(contentWidth)}</Text>
        </Box>
      ) : null}
    </ConfirmCard>
  );
}
