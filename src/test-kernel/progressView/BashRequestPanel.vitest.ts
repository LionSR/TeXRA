// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { BashRequestPanel } from '@progressView/frontend/components/BashRequestPanel';
import type { BashPermission } from '@shared/schemas';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

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

function mountPanel(
  permission: BashRequestPanel['permission'],
): Promise<BashRequestPanel> {
  return mountComponent<BashRequestPanel>('bash-request-panel', { permission });
}

type ApproveSplit = HTMLElement & { canBypass?: boolean };

function querySplitButton(element: BashRequestPanel): ApproveSplit | null {
  return (
    element.shadowRoot?.querySelector<ApproveSplit>('approve-split-button') ??
    null
  );
}

// The bash panel gets the Yolo affordance from shared BaseBypassApprovalPanel
// logic; these tests guard that it wires it up.
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
