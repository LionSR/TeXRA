import { Box, Text } from 'ink';

import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { KeyHints } from '../ui/KeyHints';
import { Select, type SelectItem } from '../ui/Select';
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
      return 'auto-approve privileged actions';
  }
}

export const APPROVAL_POLICY_ITEMS = [
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
    label: 'Auto-approve',
    description: formatApprovalPolicyForCli('yolo'),
  },
] as const satisfies ReadonlyArray<SelectItem<CliApprovalPolicy>>;

export function ApprovalPolicyForm(
  props: ApprovalPolicyFormProps,
): React.JSX.Element {
  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame color="cyan" title="/approval" showCloseHint={false}>
        <Select
          items={APPROVAL_POLICY_ITEMS}
          activeValue={props.currentPolicy}
          maxVisibleItems={APPROVAL_POLICY_ITEMS.length}
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
      <Text dimColor>
        Choose when privileged actions prompt or auto-approve.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={APPROVAL_POLICY_ITEMS}
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
