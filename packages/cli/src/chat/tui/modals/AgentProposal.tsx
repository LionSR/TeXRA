import { Box, Text } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { AgentProposalPermission } from '@shared/schemas';

import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  const p = props.payload as Record<string, unknown>;
  const agent = typeof p.agent === 'string' ? p.agent : '(agent)';
  const instruction =
    typeof p.instruction === 'string' ? p.instruction : '(no instruction)';

  return (
    <Box
      borderStyle="double"
      borderColor="magenta"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="magenta">
        Spawn {agent}?
      </Text>
      <Box marginY={1}>
        <Text>{instruction}</Text>
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
