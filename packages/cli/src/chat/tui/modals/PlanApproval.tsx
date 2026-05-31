import { Box, Text } from 'ink';

import type { PlanApprovalPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const { summary, steps } = props.payload.plan;

  return (
    <ConfirmCard
      borderStyle="double"
      color="blue"
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
    </ConfirmCard>
  );
}
