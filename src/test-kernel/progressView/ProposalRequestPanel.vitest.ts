// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ProposalRequestPanel } from '@progressView/frontend/components/ProposalRequestPanel';
import type { RunId } from '@shared/schemas';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function createPermission(): ProposalRequestPanel['permission'] {
  return {
    kind: 'proposal',
    data: {
      requestId: 'proposal-1',
      runId: 'run-a' as RunId,
      task: true,
      agent: 'writer',
      agentSource: null,
      model: 'sonnet',
      instruction: 'Revise the introduction.',
      memories: [],
      workingDirectory: null,
      inputFiles: ['/workspace/paper.tex'],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: ['/workspace/paper_revised.tex'],
      options: {},
    },
  };
}

function mountPanel(
  permission: ProposalRequestPanel['permission'] = createPermission(),
): Promise<ProposalRequestPanel> {
  return mountComponent<ProposalRequestPanel>('proposal-request-panel', {
    permission,
  });
}

/**
 * Regression coverage for the a11y-clickables audit: clickable file-name
 * spans relied on a container `@click` delegate with no role/tabindex/
 * keydown, so keyboard users could never open a proposal's input/output
 * files. Mirrors FileList.ts's `.file-path[data-command]` keyboard
 * delegation for the same "click a file name to open it" job.
 */
describe('proposal-request-panel file-name keyboard activation', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ProposalRequestPanel'),
  );

  it('maps the menu and a shortcut to approve-all while y stays one-off', async () => {
    const element = await mountPanel();
    const actions = recordPermissionActions(element);
    const grant = element.shadowRoot?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="grant"]',
    );

    expect(grant?.textContent?.trim()).toBe(
      'Approve all agent work in this task',
    );
    element.shadowRoot?.querySelector('.request-grant-menu')?.dispatchEvent(
      new CustomEvent('wa-select', {
        detail: { item: grant },
        bubbles: true,
        composed: true,
      }),
    );
    expect(element.handleKeyboardShortcut('a')).toBe(true);
    expect(element.handleKeyboardShortcut('y')).toBe(true);

    const superYolo = {
      kind: 'policy.set',
      change: {
        field: 'bypass',
        runId: 'run-a',
        bypass: 'superYolo',
        enabled: true,
        exceptRequestId: 'proposal-1',
      },
    };
    // Approve-all is the bypass and then the plain approve arm `y` sends.
    const approve = {
      kind: 'request.decide',
      runId: 'run-a',
      requestId: 'proposal-1',
      decision: { action: 'approve' },
    };
    expect(actions).toEqual([superYolo, approve, superYolo, approve, approve]);
  });
});
