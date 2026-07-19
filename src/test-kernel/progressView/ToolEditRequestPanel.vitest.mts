// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ToolEditRequestPanel } from '@progressView/frontend/components/ToolEditRequestPanel';
import type { ToolEditPermission } from '@shared/schemas';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

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

async function mountPanel(
  permission: ToolEditRequestPanel['permission'],
): Promise<ToolEditRequestPanel> {
  const element = document.createElement(
    'tool-edit-request-panel',
  ) as ToolEditRequestPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

type DiffView = HTMLElement & { originalText?: string; proposedText?: string };
type ApproveSplit = HTMLElement & { canBypass?: boolean };

function queryDiffView(element: ToolEditRequestPanel): DiffView | null {
  return element.shadowRoot?.querySelector<DiffView>('texra-diff-view') ?? null;
}

function querySplitButton(element: ToolEditRequestPanel): ApproveSplit | null {
  return (
    element.shadowRoot?.querySelector<ApproveSplit>('approve-split-button') ??
    null
  );
}

function recordPermissionActions(
  element: ToolEditRequestPanel,
): Array<{ action: string }> {
  const actions: Array<{ action: string }> = [];
  element.addEventListener('permission-action', (event) => {
    actions.push(
      (event as CustomEvent<{ decision: { action: string } }>).detail.decision,
    );
  });
  return actions;
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

    const diffView = queryDiffView(element);
    expect(diffView).toBeTruthy();
    expect(diffView?.originalText).toBe('');
    expect(diffView?.proposedText).toBe('new content\n');
  });

  it('renders inline diff when only original content is available', async () => {
    const element = await mountPanel(
      createPermission({
        originalContent: 'deleted content\n',
      }),
    );

    element.handleKeyboardShortcut('d');
    await element.updateComplete;

    const diffView = queryDiffView(element);
    expect(diffView).toBeTruthy();
    expect(diffView?.originalText).toBe('deleted content\n');
    expect(diffView?.proposedText).toBe('');
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
