// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports
import type { ApproveSplitButton } from '@progressView/frontend/components/ApproveSplitButton';
import type { ProposalRequestPanel } from '@progressView/frontend/components/ProposalRequestPanel';
import { AgentCategory, DEFAULT_TOOL_CONFIG } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  dispatchKey,
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

type PostedMessage = { command: string; file?: string };
let posted: PostedMessage[] = [];

// Install the host-bridge stub at module scope, BEFORE the DOM harness
// imports the panel module — `hostBridge` resolves this global at module
// load (see MainAppPersistenceRestore.vitest.ts for the same pattern).
(globalThis as Record<string, unknown>)[HOST_BRIDGE_API_KEY] = {
  postMessage: (message: unknown) => {
    posted.push(message as PostedMessage);
  },
  getState: () => undefined,
  setState: () => undefined,
};

function createPermission(): ProposalRequestPanel['permission'] {
  return {
    kind: 'proposal',
    data: {
      requestId: 'proposal-1',
      streamId: 'stream-a',
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

  beforeEach(() => {
    posted = [];
  });

  it('uses a shared tooltip for the direct Setup action', async () => {
    const element = await mountPanel();
    const setup = element.shadowRoot?.querySelector('#proposal-setup-button');

    expect(setup).toBeTruthy();
    expect(setup?.hasAttribute('title')).toBe(false);
    expect(
      element.shadowRoot
        ?.querySelector('wa-tooltip[for="proposal-setup-button"]')
        ?.textContent?.trim(),
    ).toBe('Setup (s)');
  });

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

    expect(actions).toEqual([
      { action: 'approveSuperYolo' },
      { action: 'approveSuperYolo' },
      { action: 'approve' },
    ]);
  });

  it('renders archived proposal approval as a plain disabled button', async () => {
    const element = await mountPanel();
    (element as unknown as { archived: boolean }).archived = true;
    element.requestUpdate();
    await element.updateComplete;

    const split = element.shadowRoot?.querySelector<ApproveSplitButton>(
      'approve-split-button',
    );
    await split?.updateComplete;

    expect(split?.disabled).toBe(true);
    expect(split?.shadowRoot?.querySelector('wa-button-group')).toBeNull();
    expect(split?.shadowRoot?.querySelector('wa-dropdown')).toBeNull();
    expect(
      split?.shadowRoot
        ?.querySelector('wa-button[data-action="approve"]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
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

    expect(actions).toEqual([
      { action: 'approve', model: 'opus', agent: 'reviewer' },
      { action: 'approveSuperYolo', model: 'opus', agent: 'reviewer' },
      { action: 'setup' },
      { action: 'reject' },
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
    permission.modelOptionsData = [{ value: 'sonnet', label: 'Sonnet' }];
    permission.agentOptionsData = [{ value: 'writer', label: 'Writer' }];

    const element = await mountPanel(permission);
    const summary = element.shadowRoot?.querySelector(
      '.workflow-proposal__workflow-summary',
    );
    const details = element.shadowRoot?.querySelector(
      'wa-details.workflow-proposal__workflow-details',
    );

    expect(summary?.textContent).toContain('review-team');
    expect(summary?.textContent).toContain('2 tasks · 2 phases');
    expect(summary?.textContent).toContain('Review');
    expect(element.shadowRoot?.textContent).toContain('Multi-agent workflow');
    expect(element.shadowRoot?.textContent).toContain('Default agent: writer');
    expect(element.shadowRoot?.textContent).toContain('high model cost');
    expect(details?.hasAttribute('open')).toBe(false);
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

  it('exposes role=button and tabindex=0 on every clickable file-name span', async () => {
    const element = await mountPanel();
    const names = element.shadowRoot?.querySelectorAll(
      '.workflow-proposal__file-name',
    );
    expect(names?.length).toBeGreaterThan(0);
    for (const name of names ?? []) {
      expect(name.getAttribute('role')).toBe('button');
      expect(name.getAttribute('tabindex')).toBe('0');
      expect(name.hasAttribute('title')).toBe(false);
      expect(
        element.shadowRoot?.querySelector(`wa-tooltip[for="${name.id}"]`),
      ).toBeTruthy();
    }
  });

  it('opens the file on Enter and Space, not on other keys', async () => {
    const element = await mountPanel();
    const fileName = element.shadowRoot?.querySelector(
      '.workflow-proposal__file-name',
    );
    expect(fileName).toBeInstanceOf(HTMLElement);

    dispatchKey(fileName!, 'a');
    expect(posted).toHaveLength(0);

    dispatchKey(fileName!, 'Enter');
    dispatchKey(fileName!, ' ');

    const openPaper = {
      command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
      file: '/workspace/paper.tex',
    };
    expect(posted).toEqual([openPaper, openPaper]);
  });

  it('does not add role/tabindex to read-only (non-clickable) file names', async () => {
    const permission = createPermission();
    permission.data.memories = ['/memories/notes.md'];
    const element = await mountPanel(permission);

    const readonlyName = element.shadowRoot?.querySelector(
      '.workflow-proposal__file-name--readonly',
    );
    expect(readonlyName).toBeInstanceOf(HTMLElement);
    expect(readonlyName?.hasAttribute('role')).toBe(false);
    expect(readonlyName?.hasAttribute('tabindex')).toBe(false);

    dispatchKey(readonlyName!, 'Enter');
    expect(posted).toHaveLength(0);
  });
});
