import { Text } from 'ink';

import {
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';

import { ListForm } from './_shared/ListForm';

interface ApprovalPolicyFormProps {
  readonly currentPolicy: TexraApprovalPolicy;
  readonly availableRows?: number;
  readonly onSelect: (value: TexraApprovalPolicy) => void;
  readonly onCancel: () => void;
}

export function ApprovalPolicyForm(
  props: ApprovalPolicyFormProps,
): React.JSX.Element {
  return (
    <ListForm
      title="/approval"
      availableRows={props.availableRows}
      items={TEXRA_APPROVAL_POLICY_OPTIONS}
      compactVisibleItems={TEXRA_APPROVAL_POLICY_OPTIONS.length}
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
