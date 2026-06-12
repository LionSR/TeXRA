import { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { PlanApprovalPermission } from '@shared/schemas';

import { ConfirmCard, CONFIRM_CARD_HORIZONTAL_DECORATION } from './ConfirmCard';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { fillRows } from '../render/terminalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly availableRows?: number;
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export const COMPACT_PLAN_APPROVAL_MAX_ROWS = 7;
const MIN_PLAN_APPROVAL_CONTENT_WIDTH = 20;

export function isCompactPlanApprovalRows(
  availableRows: number | undefined,
): boolean {
  return (
    availableRows !== undefined &&
    availableRows > 0 &&
    availableRows <= COMPACT_PLAN_APPROVAL_MAX_ROWS
  );
}

export function renderCompactPlanLine(
  line: string,
  isLastVisibleLine: boolean,
  hiddenLineCount: number,
): string {
  if (!isLastVisibleLine || hiddenLineCount === 0) return line || ' ';
  if (!line.trim()) return `… ${hiddenLineCount} more lines`;
  return `${line} · … ${hiddenLineCount} more`;
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
  const contentWidth = Math.max(MIN_PLAN_APPROVAL_CONTENT_WIDTH, width);
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
  const compact = isCompactPlanApprovalRows(props.availableRows);
  const contentWidth = compact
    ? columns
    : columns - CONFIRM_CARD_HORIZONTAL_DECORATION;
  const bodyLines = useMemo(
    () =>
      planApprovalDisplayLines({
        objective: props.payload.plan.objective,
        width: contentWidth,
        padLines: !compact,
      }),
    [compact, contentWidth, props.payload.plan.objective],
  );
  const compactBodyRows = compact
    ? Math.max(0, (props.availableRows ?? 1) - 1)
    : undefined;
  const visibleCompactBodyLines =
    compactBodyRows === undefined ? [] : bodyLines.slice(0, compactBodyRows);
  const hiddenCompactBodyLines =
    compactBodyRows === undefined
      ? 0
      : Math.max(0, bodyLines.length - compactBodyRows);

  return (
    <ConfirmCard
      borderStyle="double"
      color="blue"
      compact={compact}
      title="Approve plan?"
      extraActions={
        props.payload.goalEnabled
          ? [
              {
                key: 'r',
                label: 'approve & run',
                decision: {
                  accepted: true,
                  planAction: 'approve_and_goal',
                },
              },
            ]
          : []
      }
      feedbackPlaceholder="Feedback to send with rejection"
      onDecide={props.onDecide}
    >
      {compact ? (
        <Box flexDirection="column">
          {visibleCompactBodyLines.map((line, index) => (
            <Text key={index} wrap="truncate-end">
              {renderCompactPlanLine(
                line,
                index === visibleCompactBodyLines.length - 1,
                hiddenCompactBodyLines,
              )}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" marginY={1}>
          {bodyLines.map((line, index) => (
            <Text key={index}>{line || ' '}</Text>
          ))}
        </Box>
      )}
    </ConfirmCard>
  );
}
