import { Box, Text } from 'ink';

import type { CliApprovalPolicy } from '../../../runtime/approvalPolicy';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface ApprovalPolicyFormProps {
  readonly currentPolicy: CliApprovalPolicy;
  readonly onSelect: (value: CliApprovalPolicy) => void;
  readonly onCancel: () => void;
}

export function formatApprovalPolicyForCli(policy: CliApprovalPolicy): string {
  switch (policy) {
    case 'ask':
      return 'ask before privileged actions';
    case 'never':
      return 'deny privileged actions';
    case 'yolo':
      return 'approve privileged actions';
  }
}

export function ApprovalPolicyForm(
  props: ApprovalPolicyFormProps,
): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        /approval
      </Text>
      <Text dimColor>Choose how privileged actions should be handled.</Text>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={[
            {
              value: 'ask',
              label: 'Ask',
              description: formatApprovalPolicyForCli('ask'),
            },
            {
              value: 'never',
              label: 'Never',
              description: formatApprovalPolicyForCli('never'),
            },
            {
              value: 'yolo',
              label: 'Approve',
              description: formatApprovalPolicyForCli('yolo'),
            },
          ]}
          activeValue={props.currentPolicy}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-3', action: 'select' },
          ]}
        />
      </Box>
    </Box>
  );
}
