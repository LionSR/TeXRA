// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ProposalRequestPanel } from '@progressView/frontend/components/ProposalRequestPanel';
import { AgentCategory, DEFAULT_TOOL_CONFIG } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  dispatchKey,
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function createPermission(): ProposalRequestPanel['permission'] {
  return {
    kind: 'proposal',
    data: {
      requestId: 'proposal-1',
      runId: 'run-a' as RunId,
      agentCategory: AgentCategory.Workflow,
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
      toolConfig: { ...DEFAULT_TOOL_CONFIG },
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
      'Approve all agent work in this run',
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
      },
    };
    // Approve-all carries the (unselected) overrides beside the bypass; the
    // one-off `y` is the plain approve arm.
    const approveAll = {
      kind: 'request.decide',
      runId: 'run-a',
      requestId: 'proposal-1',
      decision: { action: 'approve', model: null, agent: null },
    };
    const approve = {
      kind: 'request.decide',
      runId: 'run-a',
      requestId: 'proposal-1',
      decision: { action: 'approve' },
    };
    expect(actions).toEqual([
      superYolo,
      approveAll,
      superYolo,
      approveAll,
      approve,
    ]);
  });

  it('attaches selected overrides only to approval decisions', async () => {
    const permission = createPermission();
    permission.modelOptionsData = [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ];
    permission.agentOptionsData = [
      { value: 'writer', label: 'Writer' },
      { value: 'reviewer', label: 'Reviewer' },
    ];
    const element = await mountPanel(permission);
    const actions = recordPermissionActions(element);
    const modelSelect = element.shadowRoot?.querySelector(
      '.proposal-model-dropdown',
    ) as HTMLElement & { value?: string };
    const agentSelect = element.shadowRoot?.querySelector(
      '.proposal-agent-dropdown',
    ) as HTMLElement & { value?: string };

    modelSelect.value = 'opus';
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    agentSelect.value = 'reviewer';
    agentSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(element.handleKeyboardShortcut('y')).toBe(true);
    expect(element.handleKeyboardShortcut('a')).toBe(true);
    expect(element.handleKeyboardShortcut('s')).toBe(true);
    expect(element.handleKeyboardShortcut('n')).toBe(true);

    const decisionOf = (request: (typeof actions)[number]) =>
      'decision' in request ? request.decision : request.kind;
    expect(actions.map(decisionOf)).toEqual([
      { action: 'approve', model: 'opus', agent: 'reviewer' },
      'policy.set',
      { action: 'approve', model: 'opus', agent: 'reviewer' },
      { action: 'setup' },
      { action: 'reject' },
    ]);
  });

  it('opens the file on Enter and Space, not on other keys', async () => {
    const element = await mountPanel();
    const posted = recordPermissionActions(element);
    const fileName = element.shadowRoot?.querySelector(
      '.workflow-proposal__file-name',
    );
    expect(fileName).toBeInstanceOf(HTMLElement);

    dispatchKey(fileName!, 'a');
    expect(posted).toHaveLength(0);

    dispatchKey(fileName!, 'Enter');
    dispatchKey(fileName!, ' ');

    const openPaper = {
      kind: 'openFile',
      path: '/workspace/paper.tex',
      line: null,
    };
    expect(posted).toEqual([openPaper, openPaper]);
  });
});
