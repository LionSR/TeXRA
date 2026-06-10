import { Box, Text } from 'ink';

import type { PlanApprovalPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly availableRows?: number;
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export const COMPACT_PLAN_APPROVAL_MAX_ROWS = 7;

export function isCompactPlanApprovalRows(
  availableRows: number | undefined,
): boolean {
  return (
    availableRows !== undefined &&
    availableRows > 0 &&
    availableRows <= COMPACT_PLAN_APPROVAL_MAX_ROWS
  );
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const bodyLines = props.payload.plan.objective.split('\n');
  const compact = isCompactPlanApprovalRows(props.availableRows);
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
              {index === visibleCompactBodyLines.length - 1 &&
              hiddenCompactBodyLines > 0
                ? `${line} · … ${hiddenCompactBodyLines} more`
                : line || ' '}
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
