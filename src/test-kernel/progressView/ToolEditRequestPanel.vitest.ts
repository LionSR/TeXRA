// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

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

  // This suite exercises the desktop, the only host that registers
  // `<texra-diff-view>` and so the only one offering the inline diff. A stub
  // stands in for the Monaco-backed element: the panel only sets properties on
  // it, and registration is what the panel actually branches on. The
  // extension/trace-viewer behavior lives in
  // ToolEditRequestPanelWithoutMonaco.vitest.ts, which needs a registry that
  // never sees this definition.
  beforeAll(() => {
    customElements.define('texra-diff-view', class extends HTMLElement {});
  });

  it('uses a shared tooltip for the direct diff action', async () => {
    const element = await mountPanel(
      createPermission({ originalContent: 'before', proposedContent: 'after' }),
    );
    const button = element.shadowRoot?.querySelector('#tool-edit-diff-button');

    expect(button).toBeTruthy();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(tooltipText(element, 'tool-edit-diff-button')).toBe(
      'Open inline diff (d)',
    );
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

  it.each([
    {
      name: 'only proposed content is available',
      permission: { proposedContent: 'new content\n' },
      originalText: '',
      proposedText: 'new content\n',
    },
    {
      name: 'only original content is available',
      permission: { originalContent: 'deleted content\n' },
      originalText: 'deleted content\n',
      proposedText: '',
    },
  ])(
    'renders inline diff when $name',
    async ({ permission, originalText, proposedText }) => {
      const element = await mountPanel(createPermission(permission));

      element.handleKeyboardShortcut('d');
      await element.updateComplete;

      const diffView = queryDiffView(element);
      expect(diffView).toBeTruthy();
      expect(diffView?.originalText).toBe(originalText);
      expect(diffView?.proposedText).toBe(proposedText);
    },
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
