// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports
import type { ProposalRequestPanel } from '@progressView/frontend/components/ProposalRequestPanel';
import { AgentCategory } from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type PostedMessage = { command: string; file?: string };
let posted: PostedMessage[] = [];

// Install the host-bridge stub at module scope, BEFORE the DOM harness
// imports the panel module — `hostBridge` resolves this global at module
// load (see MainAppPersistenceRestore.vitest.mts for the same pattern).
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
      proposalId: 'proposal-1',
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

async function mountPanel(
  permission: ProposalRequestPanel['permission'] = createPermission(),
): Promise<ProposalRequestPanel> {
  const element = document.createElement(
    'proposal-request-panel',
  ) as ProposalRequestPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function dispatchKey(target: Element, key: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

function recordPermissionActions(
  element: ProposalRequestPanel,
): Array<{ action: string }> {
  const actions: Array<{ action: string }> = [];
  element.addEventListener('permission-action', (event) => {
    actions.push(
      (event as CustomEvent<{ decision: { action: string } }>).detail.decision,
    );
  });
  return actions;
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

  it('attaches selected overrides only to approval decisions', async () => {
    const permission = createPermission();
    permission.modelOptions = [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ];
    permission.agentOptions = [
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

  it('exposes role=button and tabindex=0 on every clickable file-name span', async () => {
    const element = await mountPanel();
    const names = element.shadowRoot?.querySelectorAll(
      '.workflow-proposal__file-name',
    );
    expect(names?.length).toBeGreaterThan(0);
    for (const name of names ?? []) {
      expect(name.getAttribute('role')).toBe('button');
      expect(name.getAttribute('tabindex')).toBe('0');
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

    expect(posted).toEqual([
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: '/workspace/paper.tex',
      },
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: '/workspace/paper.tex',
      },
    ]);
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
