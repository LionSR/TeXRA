// Node imports
import { readFileSync } from 'node:fs';

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
  data: Partial<ToolEditPermission> = {},
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

function selectDiffMenuItem(
  element: ToolEditRequestPanel,
  value: string,
): void {
  const dropdown = element.shadowRoot?.querySelector('wa-dropdown');
  const item = element.shadowRoot?.querySelector<HTMLElement>(
    `wa-dropdown-item[value="${value}"]`,
  );
  dropdown?.dispatchEvent(
    new CustomEvent('wa-select', {
      detail: { item },
      bubbles: true,
      composed: true,
    }),
  );
}

describe('tool-edit-request-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ToolEditRequestPanel'),
  );

  it('uses a shared tooltip for the direct diff action', async () => {
    const element = await mountPanel(createPermission());
    const button = element.shadowRoot?.querySelector('#tool-edit-diff-button');

    expect(button).toBeTruthy();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(tooltipText(element, 'tool-edit-diff-button')).toBe('Open diff (d)');
  });

  it('keeps the non-LaTeX diff action as a plain standalone button', async () => {
    const element = await mountPanel(createPermission());
    const button = element.shadowRoot?.querySelector(
      'wa-button[data-action="openDiff"]',
    );

    expect(element.shadowRoot?.querySelector('wa-button-group')).toBeNull();
    expect(element.shadowRoot?.querySelector('wa-dropdown')).toBeNull();
    expect(button?.classList.contains('action-button')).toBe(true);
  });

  it('uses a native compact split button for LaTeX diff actions', async () => {
    const element = await mountPanel(createPermission({ isLatex: true }));
    const group = element.shadowRoot?.querySelector('wa-button-group');
    const button = group?.querySelector<HTMLElement>(
      'wa-button[data-action="openDiff"]',
    );
    const menu = group?.querySelector('wa-dropdown');
    const trigger = menu?.querySelector<HTMLElement>(
      'wa-button[slot="trigger"]',
    );

    expect(group?.getAttribute('label')).toBe('Diff actions');
    expect(button?.parentElement).toBe(group);
    expect(menu?.parentElement).toBe(group);
    expect(button?.classList.contains('action-button')).toBe(false);
    expect(button?.getAttribute('appearance')).toBe('plain');
    expect(button?.getAttribute('variant')).toBe('neutral');
    expect(button?.getAttribute('size')).toBe('s');
    expect(menu?.getAttribute('placement')).toBe('bottom-end');
    expect(trigger?.getAttribute('appearance')).toBe('plain');
    expect(trigger?.getAttribute('variant')).toBe('neutral');
    expect(trigger?.getAttribute('size')).toBe('s');
    expect(trigger?.getAttribute('aria-label')).toBe('More diff actions');
    expect(tooltipText(element, 'tool-edit-diff-button')).toBe('Open diff (d)');
    expect(tooltipText(element, 'tool-edit-diff-dropdown-trigger')).toBe(
      'More diff actions',
    );
    for (const anchorId of [
      'tool-edit-diff-button',
      'tool-edit-diff-dropdown-trigger',
    ]) {
      expect(
        element.shadowRoot?.querySelector(`wa-tooltip[for="${anchorId}"]`)
          ?.parentNode,
      ).toBe(group?.parentNode);
    }
    expect(
      [...(element.shadowRoot?.querySelectorAll('[class]') ?? [])].some(
        (node) =>
          [...node.classList].some((name) => name.startsWith('split-button')),
      ),
    ).toBe(false);
  });

  it('dispatches the primary and menu diff actions', async () => {
    const element = await mountPanel(createPermission({ isLatex: true }));
    const actions = recordPermissionActions(element);

    element.shadowRoot
      ?.querySelector<HTMLElement>('wa-button[data-action="openDiff"]')
      ?.click();
    selectDiffMenuItem(element, 'previewProposed');
    selectDiffMenuItem(element, 'showLatexdiff');

    expect(actions).toStrictEqual([
      { action: 'openDiff' },
      { action: 'previewProposed' },
      { action: 'showLatexdiff' },
    ]);
  });

  it('keeps archived diff controls plain and disabled', async () => {
    const element = await mountPanel(createPermission({ isLatex: true }));
    (element as unknown as { archived: boolean }).archived = true;
    element.requestUpdate();
    await element.updateComplete;

    const button = element.shadowRoot?.querySelector(
      'wa-button[data-action="openDiff"]',
    );
    expect(element.shadowRoot?.querySelector('wa-button-group')).toBeNull();
    expect(element.shadowRoot?.querySelector('wa-dropdown')).toBeNull();
    expect(button?.hasAttribute('disabled')).toBe(true);
  });

  it('keeps native caret state motion-safe and removes legacy split styles', () => {
    const toolEditStyles = readFileSync(
      'packages/extension/src/progressView/frontend/components/ToolEditRequestPanel.styles.ts',
      'utf8',
    );
    const approveButton = readFileSync(
      'packages/extension/src/progressView/frontend/components/ApproveSplitButton.ts',
      'utf8',
    );

    expect(toolEditStyles).toContain('.diff-dropdown-menu[open]');
    expect(approveButton).toContain('.approve-split-menu[open]');
    expect(toolEditStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(approveButton).toContain('@media (prefers-reduced-motion: reduce)');

    for (const source of [
      readFileSync('src/shared/wa/splitButton.ts', 'utf8'),
      readFileSync('src/shared/styles/controlStyles.ts', 'utf8'),
      toolEditStyles,
    ]) {
      expect(source).not.toContain('split-button');
    }
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
    const element = await mountPanel(createPermission());
    const actions = recordPermissionActions(element);

    expect(element.handleKeyboardShortcut('d')).toBe(true);
    await element.updateComplete;
    expect(element.handleKeyboardShortcut('d')).toBe(true);
    await element.updateComplete;

    expect(actions).toEqual([{ action: 'openDiff' }, { action: 'openDiff' }]);
    expect(element.shadowRoot?.querySelector('texra-diff-view')).toBeNull();
  });

  it.each([
    {
      name: 'bypass is not allowed',
      permission: createPermission({ allowBypass: false }),
    },
    {
      name: 'streamId is empty despite allowBypass',
      permission: createPermission({ allowBypass: true, streamId: '' }),
    },
  ])(
    'renders a non-bypass Approve and ignores "a" when $name',
    async ({ permission }) => {
      const element = await mountPanel(permission);
      const actions = recordPermissionActions(element);

      const split = querySplitButton(element);
      expect(split).toBeTruthy();
      expect(split?.canBypass).toBe(false);
      expect(element.handleKeyboardShortcut('a')).toBe(false);
      expect(actions).toEqual([]);
    },
  );

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
