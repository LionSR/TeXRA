import { useMemo, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { PlanApprovalPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import { COLOR_INFO } from '../ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '../ui/theme';
import { confirmCardCompactChromeRows } from './ConfirmCardState';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  fillRows,
  textDisplayWidth,
  truncateToWidth,
} from '../render/terminalText';
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
const PLAN_APPROVAL_NON_COMPACT_FIXED_ROWS = 7;
const PLAN_APPROVAL_FEEDBACK_MARGIN_ROWS = 1;
const PLAN_APPROVAL_FEEDBACK_PREFIX_COLUMNS = 2;
const PLAN_APPROVAL_FEEDBACK_PLACEHOLDER = 'Feedback to send with rejection';
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

export function planApprovalBodyRowsBudget({
  availableRows,
  goalEnabled,
  feedbackRows = 0,
}: {
  readonly availableRows: number | undefined;
  readonly goalEnabled: boolean;
  readonly feedbackRows?: number;
}): number | undefined {
  if (availableRows === undefined) return undefined;
  const noticeRows = goalEnabled ? PLAN_APPROVAL_GOAL_NOTICE_ROWS : 0;
  return Math.max(
    1,
    availableRows -
      PLAN_APPROVAL_NON_COMPACT_FIXED_ROWS -
      noticeRows -
      feedbackRows,
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
  return goalEnabled && (!compact || visibleBodyRows > 0);
}

function renderPlanLineWithSuffix({
  line,
  suffix,
  width,
}: {
  readonly line: string;
  readonly suffix: string;
  readonly width: number;
}): string {
  const lineWidth = Math.max(1, width);
  const visibleSuffix = truncateToWidth(suffix, lineWidth);
  const prefixWidth = Math.max(0, lineWidth - textDisplayWidth(visibleSuffix));
  const prefix =
    prefixWidth === 0 ? '' : truncateToWidth(line.trimEnd(), prefixWidth);
  return fillRows(`${prefix}${visibleSuffix}`, lineWidth);
}

export function renderCompactPlanLine(
  line: string,
  isLastVisibleLine: boolean,
  hiddenLineCount: number,
  width?: number,
): string {
  if (!isLastVisibleLine || hiddenLineCount === 0) return line || ' ';
  const suffix = line.trim()
    ? ` · … ${hiddenLineCount} more`
    : `… ${hiddenLineCount} more lines`;
  if (width === undefined) return line.trim() ? `${line}${suffix}` : suffix;
  return renderPlanLineWithSuffix({ line, suffix, width });
}

export function planApprovalDisplayLines({
  objective,
  width,
  padLines = false,
}: {
  readonly objective: string;
  readonly width: number;
  readonly padLines?: boolean;
}): string[] {
  const contentWidth = clampModalWidth(width);
  return objective.split('\n').flatMap((line) => {
    if (line.length === 0) return [padLines ? fillRows('', contentWidth) : ''];
    const wrapped = wrapAnsiToWidth(line, contentWidth)
      .split('\n')
      .map((part, index) => (index === 0 ? part : part.trimStart()));
    return padLines
      ? wrapped.map((part) => fillRows(part, contentWidth))
      : wrapped;
  });
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState('');
  const goalEnabled = props.payload.goalEnabled;
  const compact = isCompactPlanApprovalRows(props.availableRows, goalEnabled);
  const contentWidth = compact
    ? columns
    : columns - CONFIRM_CARD_HORIZONTAL_DECORATION;
  const initialCompactBodyRows = compact
    ? planApprovalCompactBodyRowsBudget({
        availableRows: props.availableRows,
        columns,
        goalEnabled,
      })
    : undefined;
  const goalActionVisible = isPlanApprovalGoalActionVisible({
    compact,
    goalEnabled,
    visibleBodyRows: initialCompactBodyRows ?? 0,
  });
  const goalNoticeVisible = goalActionVisible && !feedbackMode;
  const bodyObjective =
    compact && goalNoticeVisible
      ? `${PLAN_APPROVAL_GOAL_NOTICE}\n\n${props.payload.plan.objective}`
      : props.payload.plan.objective;
  const bodyLines = useMemo(
    () =>
      planApprovalDisplayLines({
        objective: bodyObjective,
        width: contentWidth,
        padLines: !compact,
      }),
    [bodyObjective, compact, contentWidth],
  );
  const compactBodyRows = compact
    ? planApprovalCompactBodyRowsBudget({
        availableRows: props.availableRows,
        columns,
        goalEnabled: goalActionVisible,
      })
    : undefined;
  const visibleCompactBodyLines =
    compactBodyRows === undefined ? [] : bodyLines.slice(0, compactBodyRows);
  const hiddenCompactBodyLines =
    compactBodyRows === undefined
      ? 0
      : Math.max(0, bodyLines.length - compactBodyRows);
  const nonCompactBodyRows = compact
    ? undefined
    : planApprovalBodyRowsBudget({
        availableRows: props.availableRows,
        goalEnabled: goalNoticeVisible,
        feedbackRows: feedbackMode
          ? planApprovalFeedbackRows({ columns, value: feedbackValue })
          : 0,
      });
  const visibleNonCompactBodyLines =
    nonCompactBodyRows === undefined
      ? bodyLines
      : bodyLines.slice(0, nonCompactBodyRows);
  const hiddenNonCompactBodyLines =
    nonCompactBodyRows === undefined
      ? 0
      : Math.max(0, bodyLines.length - nonCompactBodyRows);
  const visibleBodyLines = compact
    ? visibleCompactBodyLines
    : visibleNonCompactBodyLines;
  const hiddenBodyLineCount = compact
    ? hiddenCompactBodyLines
    : hiddenNonCompactBodyLines;

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
      <Box flexDirection="column" marginY={compact ? 0 : 1}>
        {visibleBodyLines.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {renderCompactPlanLine(
              line,
              index === visibleBodyLines.length - 1,
              hiddenBodyLineCount,
              contentWidth,
            )}
          </Text>
        ))}
        {!compact && goalNoticeVisible ? (
          <>
            <Text> </Text>
            <Text>{planApprovalGoalNoticeLine(contentWidth)}</Text>
          </>
        ) : null}
      </Box>
    </ConfirmCard>
  );
}
