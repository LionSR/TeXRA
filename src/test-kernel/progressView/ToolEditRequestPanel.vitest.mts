// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { PermissionState } from '@progressView/frontend/permissionState';
import type { ToolEditRequestPanel } from '@progressView/frontend/components/ToolEditRequestPanel';

// Local imports - shared schemas
import type { ToolEditPermission } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function createPermission(data: Partial<ToolEditPermission>): PermissionState {
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

async function mountPanel(
  permission: PermissionState,
): Promise<ToolEditRequestPanel> {
  const element = document.createElement(
    'tool-edit-request-panel',
  ) as ToolEditRequestPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('tool-edit-request-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ToolEditRequestPanel'),
  );

  it('renders inline diff when only proposed content is available', async () => {
    const element = await mountPanel(
      createPermission({
        proposedContent: 'new content\n',
      }),
    );

    element.handleKeyboardShortcut('d');
    await element.updateComplete;

    const diffView = element.shadowRoot?.querySelector('texra-diff-view') as
      | HTMLElement
      | undefined;
    expect(diffView).toBeTruthy();
    expect(
      (diffView as HTMLElement & { originalText?: string }).originalText,
    ).toBe('');
    expect(
      (diffView as HTMLElement & { proposedText?: string }).proposedText,
    ).toBe('new content\n');
  });

  it('renders inline diff when only original content is available', async () => {
    const element = await mountPanel(
      createPermission({
        originalContent: 'deleted content\n',
      }),
    );

    element.handleKeyboardShortcut('d');
    await element.updateComplete;

    const diffView = element.shadowRoot?.querySelector('texra-diff-view') as
      | HTMLElement
      | undefined;
    expect(diffView).toBeTruthy();
    expect(
      (diffView as HTMLElement & { originalText?: string }).originalText,
    ).toBe('deleted content\n');
    expect(
      (diffView as HTMLElement & { proposedText?: string }).proposedText,
    ).toBe('');
  });

  it('keeps Approve plain and ignores "a" when bypass is not allowed', async () => {
    const element = await mountPanel(createPermission({ allowBypass: false }));
    const actions: string[] = [];
    element.addEventListener('permission-action', (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });

    expect(element.shadowRoot?.querySelector('.approve-split')).toBeFalsy();
    expect(
      element.shadowRoot?.querySelector(
        'wa-dropdown-item[value="approveSession"]',
      ),
    ).toBeFalsy();
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);
  });

  it('keeps Approve plain when streamId is empty even if bypass is allowed', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: '' }),
    );

    expect(element.shadowRoot?.querySelector('.approve-split')).toBeFalsy();
    expect(element.handleKeyboardShortcut('a')).toBe(false);
  });

  it('offers a Yolo split-menu option and "a" shortcut that emit approveSession', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: 'stream-1' }),
    );
    const actions: string[] = [];
    element.addEventListener('permission-action', (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });

    expect(element.shadowRoot?.querySelector('.approve-split')).toBeTruthy();
    const yoloItem = element.shadowRoot?.querySelector(
      'wa-dropdown-item[value="approveSession"]',
    ) as HTMLElement | undefined;
    expect(yoloItem).toBeTruthy();
    expect(yoloItem?.textContent).toContain('Yolo (this session)');

    expect(element.handleKeyboardShortcut('a')).toBe(true);
    expect(actions).toEqual(['approveSession']);
  });
});
