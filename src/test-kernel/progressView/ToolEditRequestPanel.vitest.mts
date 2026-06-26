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

  it('ignores "a" while the rejection feedback box is open', async () => {
    const element = await mountPanel(
      createPermission({ allowBypass: true, streamId: 'stream-1' }),
    );
    const actions: string[] = [];
    element.addEventListener('permission-action', (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });

    // First 'n' opens the feedback textarea (does not submit yet).
    expect(element.handleKeyboardShortcut('n')).toBe(true);
    await element.updateComplete;

    // With feedback focused, 'a' must not hijack typing into the textarea.
    expect(element.handleKeyboardShortcut('a')).toBe(false);
    expect(actions).toEqual([]);
  });
});
