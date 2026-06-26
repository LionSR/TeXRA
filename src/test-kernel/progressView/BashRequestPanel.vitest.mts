// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { PermissionState } from '@progressView/frontend/permissionState';
import type { BashRequestPanel } from '@progressView/frontend/components/BashRequestPanel';

// Local imports - shared schemas
import type { BashPermission } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function createPermission(data: Partial<BashPermission>): PermissionState {
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
  permission: PermissionState,
): Promise<BashRequestPanel> {
  const element = document.createElement(
    'bash-request-panel',
  ) as BashRequestPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

// Parity with ToolEditRequestPanel: the bash panel wires the Yolo affordance
// through its own `handleExtraKey('a')` override + `middleActions`, so a
// regression there would not be caught by the tool-edit tests despite the
// shared BaseFeedbackPanel logic.
describe('bash-request-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/BashRequestPanel'),
  );

  it('renders a non-bypass Approve and ignores "a" when bypass is not allowed', async () => {
    const element = await mountPanel(createPermission({ allowBypass: false }));
    const actions: string[] = [];
    element.addEventListener('permission-action', (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });

    const split = element.shadowRoot?.querySelector('approve-split-button') as
      | (HTMLElement & { canBypass?: boolean })
      | undefined;
    expect(split).toBeTruthy();
    expect(split?.canBypass).toBe(false);
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);
  });

  it('renders a non-bypass Approve when streamId is empty even if bypass is allowed', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: '' }),
    );

    const split = element.shadowRoot?.querySelector('approve-split-button') as
      | (HTMLElement & { canBypass?: boolean })
      | undefined;
    expect(split?.canBypass).toBe(false);
    expect(element.handleKeyboardShortcut('a')).toBe(false);
  });

  it('passes canBypass to the split button and "a" emits approveSession', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: 'stream-1' }),
    );
    const actions: string[] = [];
    element.addEventListener('permission-action', (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });

    const split = element.shadowRoot?.querySelector('approve-split-button') as
      | (HTMLElement & { canBypass?: boolean })
      | undefined;
    expect(split?.canBypass).toBe(true);

    expect(element.handleKeyboardShortcut('a')).toBe(true);
    expect(actions).toEqual(['approveSession']);
  });
});
