// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { BashRequestPanel } from '@progressView/frontend/components/BashRequestPanel';

// Local imports - shared schemas
import type { BashPermission } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function createPermission(
  data: Partial<BashPermission>,
): BashRequestPanel['permission'] {
  return {
    kind: 'bash',
    data: {
      requestId: 'bash-request-1',
      allowBypass: false,
      streamId: '',
      command: 'echo hi',
      ...data,
    },
  };
}

async function mountPanel(
  permission: BashRequestPanel['permission'],
): Promise<BashRequestPanel> {
  const element = document.createElement(
    'bash-request-panel',
  ) as BashRequestPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

type ApproveSplit = HTMLElement & { canBypass?: boolean };

function querySplitButton(element: BashRequestPanel): ApproveSplit | null {
  return (
    element.shadowRoot?.querySelector<ApproveSplit>('approve-split-button') ??
    null
  );
}

function recordPermissionActions(
  element: BashRequestPanel,
): Array<{ action: string }> {
  const actions: Array<{ action: string }> = [];
  element.addEventListener('permission-action', (event) => {
    actions.push(
      (event as CustomEvent<{ decision: { action: string } }>).detail.decision,
    );
  });
  return actions;
}

// Parity with ToolEditRequestPanel: the bash panel gets the Yolo affordance
// entirely from shared BaseBypassApprovalPanel logic, so these tests guard that
// the bash panel wires it up — a base-class regression would not be caught by
// the tool-edit tests alone.
describe('bash-request-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/BashRequestPanel'),
  );

  it('renders a non-bypass Approve and ignores "a" when bypass is not allowed', async () => {
    const element = await mountPanel(createPermission({ allowBypass: false }));
    const actions = recordPermissionActions(element);

    const split = querySplitButton(element);
    expect(split).toBeTruthy();
    expect(split?.canBypass).toBe(false);
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);
  });

  it('renders a non-bypass Approve when streamId is empty even if bypass is allowed', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: '' }),
    );

    const split = querySplitButton(element);
    expect(split?.canBypass).toBe(false);
    expect(element.handleKeyboardShortcut('a')).toBe(false);
  });

  it('passes canBypass to the split button and "a" emits approveSession', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: 'stream-1' }),
    );
    const actions = recordPermissionActions(element);

    const split = querySplitButton(element);
    expect(split?.canBypass).toBe(true);

    expect(element.handleKeyboardShortcut('a')).toBe(true);
    expect(actions).toEqual([{ action: 'approveSession' }]);
  });
});
