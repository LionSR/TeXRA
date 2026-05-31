import { Box, Text } from 'ink';

import type { PlanApprovalPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly availableRows?: number;
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const COMPACT_PLAN_APPROVAL_ROWS = 4;

function isCompactPlanApprovalRows(availableRows: number | undefined): boolean {
  return (
    availableRows !== undefined &&
    availableRows > 0 &&
    availableRows <= COMPACT_PLAN_APPROVAL_ROWS
  );
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const { summary, steps } = props.payload.plan;
  const compact = isCompactPlanApprovalRows(props.availableRows);
  const compactBodyRows = compact
    ? Math.max(0, (props.availableRows ?? 1) - 1)
    : undefined;
  const compactBodyLines = [
    ...(summary ? [summary] : []),
    ...steps.map((step, i) => `${i + 1}. ${step.title}`),
  ];
  const visibleCompactBodyLines =
    compactBodyRows === undefined
      ? []
      : compactBodyLines.slice(0, compactBodyRows);
  const hiddenCompactBodyLines =
    compactBodyRows === undefined
      ? 0
      : Math.max(0, compactBodyLines.length - compactBodyRows);

  return (
    <ConfirmCard
      borderStyle="double"
      color="blue"
      compact={compact}
      title="Approve plan?"
      extraActions={
        props.payload.odysseyEnabled
          ? [
              {
                key: 'r',
                label: 'approve & run',
                decision: {
                  accepted: true,
                  planAction: 'approve_and_odyssey',
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
                : line}
            </Text>
          ))}
        </Box>
      ) : (
        <>
          {summary ? (
            <Box marginY={1}>
              <Text>{summary}</Text>
            </Box>
          ) : null}
          <Box flexDirection="column">
            {steps.map((step, i) => (
              <Text key={i}>
                {i + 1}. {step.title}
                {step.description ? ` — ${step.description}` : ''}
              </Text>
            ))}
          </Box>
        </>
      )}
    </ConfirmCard>
  );
}
