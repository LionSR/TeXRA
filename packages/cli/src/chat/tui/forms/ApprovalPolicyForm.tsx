import { Text } from 'ink';

import type { SelectItem } from '@cli/tui/ui/Select';
import {
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';

import { ListForm } from './_shared/ListForm';

export interface ApprovalPolicyFormProps {
  readonly currentPolicy: TexraApprovalPolicy;
  readonly availableRows?: number;
  readonly onSelect: (value: TexraApprovalPolicy) => void;
  readonly onCancel: () => void;
}

const APPROVAL_POLICY_ITEMS =
  TEXRA_APPROVAL_POLICY_OPTIONS satisfies ReadonlyArray<
    SelectItem<TexraApprovalPolicy>
  >;

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
