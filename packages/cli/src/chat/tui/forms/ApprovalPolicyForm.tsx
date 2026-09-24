import { Text } from 'ink';

import type { SelectItem } from '@cli/tui/ui/Select';
import {
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';

import { ListForm } from './_shared/ListForm';

/** The session auto-approvals `/approval` toggles next to the policy. */
type ApprovalToggle = 'bash' | 'toolEdit' | 'goal';

export const APPROVAL_BYPASS_LABEL = {
  bash: 'Auto-approve commands',
  toolEdit: 'Auto-approve edits',
} as const;

export type ApprovalFormValue = TexraApprovalPolicy | ApprovalToggle;

interface ApprovalToggleState {
  /** Undefined until the chat has a run to carry the bypass. */
  readonly bash: boolean | undefined;
  readonly toolEdit: boolean | undefined;
  readonly goal: boolean;
}

interface ApprovalPolicyFormProps {
  readonly currentPolicy: TexraApprovalPolicy;
  readonly toggles: ApprovalToggleState;
  readonly availableRows?: number;
  readonly onSelect: (value: ApprovalFormValue) => void;
  readonly onCancel: () => void;
}

function onOff(enabled: boolean): string {
  return enabled ? 'On' : 'Off';
}

function bypassItem(
  value: 'bash' | 'toolEdit',
  label: string,
  enabled: boolean | undefined,
): SelectItem<ApprovalFormValue> {
  return enabled === undefined
    ? {
        value,
        label,
        description: 'available once the chat has started',
        disabled: true,
      }
    : { value, label, description: `${onOff(enabled)} · this session` };
}

export function ApprovalPolicyForm(
  props: ApprovalPolicyFormProps,
): React.JSX.Element {
  const { toggles } = props;
  const items: ReadonlyArray<SelectItem<ApprovalFormValue>> = [
    ...TEXRA_APPROVAL_POLICY_OPTIONS,
    bypassItem('bash', APPROVAL_BYPASS_LABEL.bash, toggles.bash),
    bypassItem('toolEdit', APPROVAL_BYPASS_LABEL.toolEdit, toggles.toolEdit),
    {
      value: 'goal',
      label: 'Goal: approve all work',
      description: toggles.goal
        ? 'On · commands, edits, and delegated work'
        : 'Off · commands only',
    },
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
          Choose when commands and edits ask first, or toggle an auto-approval.
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
