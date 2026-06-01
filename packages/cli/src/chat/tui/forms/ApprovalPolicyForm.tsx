import { Box, Text } from 'ink';

import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
import { isCompactFormRows } from './_shared/selectWindow';

export interface ApprovalPolicyFormProps {
  readonly currentPolicy: CliApprovalPolicy;
  readonly availableRows?: number;
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
  const items = [
    {
      value: 'ask' as const,
      label: 'Ask',
      description: formatApprovalPolicyForCli('ask'),
    },
    {
      value: 'never' as const,
      label: 'Never',
      description: formatApprovalPolicyForCli('never'),
    },
    {
      value: 'yolo' as const,
      label: 'Approve',
      description: formatApprovalPolicyForCli('yolo'),
    },
  ];

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame color="cyan" title="/approval" showCloseHint={false}>
        <Select
          items={items}
          activeValue={props.currentPolicy}
          maxVisibleItems={items.length}
          showOverflow={false}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
        <CompactFormKeyHints primary={{ key: '1-3/Enter', action: 'select' }} />
      </FormFrame>
    );
  }

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
          items={items}
          activeValue={props.currentPolicy}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-3', action: 'select now' },
            { key: 'Enter', action: 'select highlighted' },
            { key: 'Esc', action: 'cancel' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
