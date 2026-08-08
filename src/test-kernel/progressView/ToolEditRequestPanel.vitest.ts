// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ToolEditRequestPanel } from '@progressView/frontend/components/ToolEditRequestPanel';
import type { ToolEditPermission } from '@shared/schemas';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function createPermission(
  data: Partial<ToolEditPermission>,
): ToolEditRequestPanel['permission'] {
  return {
    kind: 'toolEdit',
    data: {
      requestId: 'request-1',
      allowBypass: false,
      streamId: '',
      path: '/workspace/example.ts',
      relativePath: 'example.ts',
      sourceTool: 'edit',
      addedLines: 1,
      removedLines: 0,
      isLatex: false,
      ...data,
    },
  };
}

function mountPanel(
  permission: ToolEditRequestPanel['permission'],
): Promise<ToolEditRequestPanel> {
  return mountComponent<ToolEditRequestPanel>('tool-edit-request-panel', {
    permission,
  });
}

type ApproveSplit = HTMLElement & { canBypass?: boolean };

function querySplitButton(element: ToolEditRequestPanel): ApproveSplit | null {
  return (
    element.shadowRoot?.querySelector<ApproveSplit>('approve-split-button') ??
    null
  );
}

function tooltipText(
  element: ToolEditRequestPanel,
  anchorId: string,
): string | undefined {
  return element.shadowRoot
    ?.querySelector(`wa-tooltip[for="${anchorId}"]`)
    ?.textContent?.trim();
}

describe('tool-edit-request-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ToolEditRequestPanel'),
  );

  it('uses a shared tooltip for the direct diff action', async () => {
    const element = await mountPanel(createPermission({}));
    const button = element.shadowRoot?.querySelector('#tool-edit-diff-button');

    expect(button).toBeTruthy();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(tooltipText(element, 'tool-edit-diff-button')).toBe('Open diff (d)');
  });

  it('anchors the line-change hint with wa-tooltip instead of title', async () => {
    const element = await mountPanel(
      createPermission({ addedLines: 2, removedLines: 1 }),
    );

    const summary = element.shadowRoot?.querySelector(
      '#tool-edit-diff-summary',
    );
    expect(summary?.hasAttribute('title')).toBe(false);
    expect(tooltipText(element, 'tool-edit-diff-summary')).toBe(
      '+2 / -1 lines changed',
    );
  });

  it('delegates the diff action to the host on every press', async () => {
    // Each host answers openDiff its own way — the extension opens a VS Code
    // diff tab, the desktop posts desktop:showDiff to its Review workbench —
    // so the panel never renders a diff itself and holds no toggle state.
    const element = await mountPanel(createPermission({}));
    const actions = recordPermissionActions(element);

    expect(element.handleKeyboardShortcut('d')).toBe(true);
    await element.updateComplete;
    expect(element.handleKeyboardShortcut('d')).toBe(true);
    await element.updateComplete;

    expect(actions).toEqual([{ action: 'openDiff' }, { action: 'openDiff' }]);
    expect(element.shadowRoot?.querySelector('texra-diff-view')).toBeNull();
  });

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

  it('ignores "a" while the rejection feedback box is open', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: 'stream-1' }),
    );
    const actions = recordPermissionActions(element);

    // First 'n' opens the feedback textarea (does not submit yet).
    expect(element.handleKeyboardShortcut('n')).toBe(true);
    await element.updateComplete;

    // With feedback focused, 'a' must not hijack typing into the textarea.
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);
  });
});
