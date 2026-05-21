import { Box, Text } from 'ink';

import {
  getProposalFileGroups,
  type AgentProposalPermission,
} from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import { agentProposalCategoryLabel } from './AgentProposalDisplay';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const FILE_LIMIT = 5;

function FileGroup(props: {
  readonly label: string;
  readonly files: readonly string[];
}): React.JSX.Element {
  const visible = props.files.slice(0, FILE_LIMIT);
  const hidden = props.files.length - visible.length;
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{props.label}: </Text>
        {visible.join(', ')}
        {hidden > 0 ? `, +${hidden} more` : ''}
      </Text>
    </Box>
  );
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  const fileGroups = getProposalFileGroups(props.payload);
  return (
    <ConfirmCard
      borderStyle="double"
      color="magenta"
      title={`Spawn ${props.payload.agent}?`}
      onDecide={props.onDecide}
    >
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Model: </Text>
          {props.payload.model}
        </Text>
        <Text>
          <Text bold>Category: </Text>
          {agentProposalCategoryLabel(props.payload.agentCategory)}
        </Text>
        {props.payload.workingDirectory ? (
          <Text>
            <Text bold>Directory: </Text>
            {props.payload.workingDirectory}
          </Text>
        ) : null}
        {fileGroups.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            {fileGroups.map((group) => (
              <FileGroup
                key={group.label}
                label={group.label}
                files={group.files}
              />
            ))}
          </Box>
        ) : null}
      </Box>
      <Box marginY={1}>
        <Text>{props.payload.instruction}</Text>
      </Box>
    </ConfirmCard>
  );
}
