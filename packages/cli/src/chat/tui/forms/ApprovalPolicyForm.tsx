import { Text } from 'ink';

import { formatCliApprovalPolicy } from '@cli/runtime/approvalPolicyText';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';

import { ListForm } from './_shared/ListForm';
import type { SelectItem } from '../ui/Select';

export interface ApprovalPolicyFormProps {
  readonly currentPolicy: CliApprovalPolicy;
  readonly availableRows?: number;
  readonly onSelect: (value: CliApprovalPolicy) => void;
  readonly onCancel: () => void;
}

export const APPROVAL_POLICY_ITEMS = [
  {
    value: 'ask',
    label: 'Ask',
    description: formatCliApprovalPolicy('ask'),
  },
  {
    value: 'never',
    label: 'Never',
    description: formatCliApprovalPolicy('never'),
  },
  {
    value: 'yolo',
    label: 'Auto-approve',
    description: formatCliApprovalPolicy('yolo'),
  },
] as const satisfies ReadonlyArray<SelectItem<CliApprovalPolicy>>;

export function ApprovalPolicyForm(
  props: ApprovalPolicyFormProps,
): React.JSX.Element {
  return (
    <ListForm
      title="/approval"
      availableRows={props.availableRows}
      items={APPROVAL_POLICY_ITEMS}
      compactVisibleItems={APPROVAL_POLICY_ITEMS.length}
      activeValue={props.currentPolicy}
      description={
        <Text dimColor>
          Choose when privileged actions prompt or auto-approve.
        </Text>
      }
      selectMarginTop={1}
      action="select"
      escapeAction="cancel"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
