// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ApproveSplitButton } from '@progressView/frontend/components/ApproveSplitButton';
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
    const split = element.shadowRoot?.querySelector<
      HTMLElement & { canApproveAllDelegatedWork?: boolean }
    >('approve-split-button');

    expect(split?.canApproveAllDelegatedWork).toBe(true);
    split?.dispatchEvent(
      new CustomEvent('approve-all-delegated-work', {
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
    const approve = {
      kind: 'decision.proposal',
      runId: 'run-a',
      approvalId: 'proposal-1',
      decision: { action: 'approve', model: null, agent: null },
    };
    expect(actions).toEqual([superYolo, approve, superYolo, approve, approve]);
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
    await element.updateComplete;
    expect(element.handleKeyboardShortcut('n')).toBe(true);

    const decisionOf = (request: (typeof actions)[number]) =>
      'decision' in request ? request.decision : request.kind;
    expect(actions.map(decisionOf)).toEqual([
      { action: 'approve', model: 'opus', agent: 'reviewer' },
      'policy.set',
      { action: 'approve', model: 'opus', agent: 'reviewer' },
      { action: 'setup' },
      { action: 'reject', feedback: null },
    ]);
  });

  it('renders a compact, explicit multi-agent workflow proposal with saved-script access', async () => {
    const permission = createPermission();
    if (permission.data.agentCategory !== AgentCategory.Workflow) {
      throw new Error('expected workflow proposal');
    }
    permission.data.workflowScript = {
      name: 'review-team',
      description: 'Review the draft in parallel',
      scriptPath: '.texra/workflow-scripts/review-team.mjs',
      phases: [{ title: 'Review' }, { title: 'Synthesize' }],
      tasks: [
        { id: 'review', label: 'Review draft', phase: 'Review' },
        { id: 'merge', label: 'Merge findings', phase: 'Synthesize' },
      ],
    };
    permission.data.model = 'gpt56';

    const element = await mountPanel(permission);

    expect(element.shadowRoot?.textContent).toContain(
      'Proposes a multi-agent run',
    );
    expect(element.shadowRoot?.textContent).toContain('review-team');
    expect(
      element.shadowRoot?.querySelector('.proposal-agent-dropdown'),
    ).toBeNull();
    expect(
      element.shadowRoot?.querySelector('.proposal-model-dropdown'),
    ).toBeNull();
    const script = element.shadowRoot?.querySelector(
      '.workflow-proposal__script-files [data-file]',
    );
    expect(script?.getAttribute('data-file')).toBe(
      '.texra/workflow-scripts/review-team.mjs',
    );
    expect(
      element.shadowRoot?.querySelector('#proposal-setup-button'),
    ).toBeTruthy();
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
