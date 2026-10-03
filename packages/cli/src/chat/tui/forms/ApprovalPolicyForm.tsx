import { Text } from 'ink';

import type { SelectItem } from '@cli/tui/ui/Select';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import {
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { RUN_GRANT_COPY } from '@ui/copy/delegationApproval';

import { ListForm } from './_shared/ListForm';

/** A policy, or a grant of the focused task to revoke. */
export type ApprovalFormValue = TexraApprovalPolicy | ApprovalBypassKind;

interface ApprovalPolicyFormProps {
  readonly currentPolicy: TexraApprovalPolicy;
  /** The focused task's grants that are on, each offered for revoking;
   *  granting is the card's `a`. */
  readonly grants: readonly ApprovalBypassKind[];
  readonly availableRows?: number;
  readonly onSelect: (value: ApprovalFormValue) => void;
  readonly onCancel: () => void;
}

/**
 * `/approval`: the policy, which applies before a task asks. Grants given on
 * a card are listed only to take them back (`/status` lists them too).
 */
export function ApprovalPolicyForm(
  props: ApprovalPolicyFormProps,
): React.JSX.Element {
  const items: ReadonlyArray<SelectItem<ApprovalFormValue>> = [
    ...TEXRA_APPROVAL_POLICY_OPTIONS,
    ...props.grants.map((kind) => ({
      value: kind,
      label: RUN_GRANT_COPY.revoke(kind),
      description: 'granted on a card in this task',
    })),
  ];
  return (
    <ListForm
      title="/approval"
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      activeValue={props.currentPolicy}
      description={
        <Text dimColor>
          Choose when commands and edits ask first. Press a on a request to
          approve all of its kind in this task.
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
