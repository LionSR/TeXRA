import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { PlanApprovalPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

export interface PlanApprovalProps {
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const steps =
    'plan' in props.payload && Array.isArray(props.payload.plan)
      ? (props.payload.plan as Array<{ description?: string; title?: string }>)
      : [];

  return (
    <Box
      borderStyle="double"
      borderColor="blue"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="blue">
        Approve plan?
      </Text>
      <Box marginY={1} flexDirection="column">
        {steps.map((step, i) => (
          <Text key={i}>
            {i + 1}. {step.description ?? step.title ?? '(step)'}
          </Text>
        ))}
      </Box>
      <Box>
        <Text dimColor>y approve · n reject · </Text>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
    </Box>
  );
}
