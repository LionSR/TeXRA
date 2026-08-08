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

// The extension webview and the trace viewer ship no Monaco and never register
// `<texra-diff-view>`; the desktop renderer does. That registration is the only
// difference, so this file deliberately defines no stub for it — a separate
// file, because a custom-element registry cannot un-define a tag once
// ToolEditRequestPanel.vitest.ts has registered it.
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

const WITH_CONTENT = {
  originalContent: 'before',
  proposedContent: 'after',
} as const;

describe('tool-edit-request-panel in a host without Monaco', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ToolEditRequestPanel'),
  );

  it('delegates to the host diff instead of rendering an unregistered element', async () => {
    // Carrying the content is what used to switch the button to the inline
    // branch. In a host that cannot render it, that branch produced an empty
    // box and swallowed the openDiff action that opens VS Code's own diff.
    const element = await mountPanel(createPermission(WITH_CONTENT));
    const actions = recordPermissionActions(element);

    expect(element.handleKeyboardShortcut('d')).toBe(true);
    await element.updateComplete;

    expect(actions).toEqual([{ action: 'openDiff' }]);
    expect(element.shadowRoot?.querySelector('texra-diff-view')).toBeNull();
  });

  it('labels the button for the host diff, not an inline toggle', async () => {
    const element = await mountPanel(createPermission(WITH_CONTENT));

    const button = element.shadowRoot?.querySelector('#tool-edit-diff-button');
    expect(button?.textContent?.trim()).toContain('Open diff');
    expect(
      element.shadowRoot
        ?.querySelector('wa-tooltip[for="tool-edit-diff-button"]')
        ?.textContent?.trim(),
    ).toBe('Open diff (d)');
  });

  it('keeps delegating on a second press rather than toggling state', async () => {
    const element = await mountPanel(createPermission(WITH_CONTENT));
    const actions = recordPermissionActions(element);

    element.handleKeyboardShortcut('d');
    await element.updateComplete;
    element.handleKeyboardShortcut('d');
    await element.updateComplete;

    expect(actions).toEqual([{ action: 'openDiff' }, { action: 'openDiff' }]);
    expect(element.shadowRoot?.querySelector('texra-diff-view')).toBeNull();
  });
});
