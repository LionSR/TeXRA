import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { PlanApprovalPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';
import { KeyHints } from '../ui/KeyHints';

export interface PlanApprovalProps {
  readonly payload: PlanApprovalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function PlanApproval(props: PlanApprovalProps): React.JSX.Element {
  const plan = props.payload.plan;
  const summary = plan?.summary;
  const steps = plan?.steps ?? [];

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
      <Box marginTop={1}>
        <ConfirmInput
          onConfirm={() => props.onDecide({ accepted: true })}
          onCancel={() => props.onDecide({ accepted: false })}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'y', action: 'approve' },
            { key: 'n', action: 'reject' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
