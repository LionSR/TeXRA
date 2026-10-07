import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AGENT_SOURCE } from '@shared/schemas';
import type { AgentSelectionItem } from '@shared/settingsView/settingsViewMessages';
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type AgentSelectionPanelElement = HTMLElement & {
  agents: AgentSelectionItem[];
  updateComplete: Promise<boolean>;
};

const taskAgent: AgentSelectionItem = {
  name: 'summarize',
  hasTask: true,
  source: AGENT_SOURCE.BUILT_IN,
  hasPath: true,
  enabled: true,
};

async function renderAgentSelectionPanel(
  agents: AgentSelectionItem[] = [taskAgent],
): Promise<AgentSelectionPanelElement> {
  const panel = await mountComponent<AgentSelectionPanelElement>(
    'agent-selection-panel',
    { agents },
  );
  await settle(panel);
  return panel;
}

function catalogOf(panel: AgentSelectionPanelElement) {
  return panel.shadowRoot!.querySelector('settings-catalog')!;
}

async function settle(panel: AgentSelectionPanelElement): Promise<void> {
  await catalogOf(panel).updateComplete;
  await panel.updateComplete;
  await catalogOf(panel).updateComplete;
}

function queryToggle(
  panel: AgentSelectionPanelElement,
): HTMLElement & { checked?: boolean } {
  const toggle = catalogOf(panel).shadowRoot!.querySelector(
    '.catalog-row-toggle',
  );
  expect(toggle).not.toBeNull();
  return toggle as HTMLElement & { checked?: boolean };
}

describe('AgentSelectionPanel', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/AgentSelectionPanel'),
  );

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('posts setAgentEnabled (not a click on the row) when the toggle is clicked', async () => {
    const panel = await renderAgentSelectionPanel();

    let rowClicked = false;
    catalogOf(panel)
      .shadowRoot!.querySelector('.catalog-row')
      ?.addEventListener('click', () => {
        rowClicked = true;
      });

    queryToggle(panel).dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
        {
          agentName: 'summarize',
          agentSource: AGENT_SOURCE.BUILT_IN,
          enabled: false,
        },
      ],
    ]);
    // The toggle's click handler stops propagation, so the row's own
    // click-to-select handler must not also fire.
    expect(rowClicked).toBe(false);
  });

  it('flags a custom copy whose built-in changed and offers its three resolutions', async () => {
    const panel = await renderAgentSelectionPanel([
      {
        ...taskAgent,
        source: AGENT_SOURCE.CUSTOM,
        newerBuiltIn: AGENT_SOURCE.BUILT_IN,
      },
    ]);
    const root = panel.shadowRoot!;
    expect(root.textContent).toContain('A newer built-in version is available');
    const buttons = [...root.querySelectorAll('wa-button')];
    const click = (text: string) =>
      buttons
        .find((button) => button.textContent?.trim() === text)!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, composed: true }),
        );
    click('View built-in');
    click('Reset to built-in');
    click('Keep mine');

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML,
        { agentName: 'summarize', agentSource: AGENT_SOURCE.BUILT_IN },
      ],
      [SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT, { agentName: 'summarize' }],
      [SETTINGS_VIEW_COMMANDS.KEEP_CUSTOM_AGENT, { agentName: 'summarize' }],
    ]);
  });

  it('filters by purpose and keeps details and keyboard selection within the results', async () => {
    const panel = await renderAgentSelectionPanel([
      { ...taskAgent, name: 'writer', description: 'Draft a manuscript' },
      { ...taskAgent, name: 'reviewer', description: 'Review a manuscript' },
      { ...taskAgent, name: 'coder', description: 'Implement code' },
    ]);
    const root = panel.shadowRoot!;
    const catalogRoot = catalogOf(panel).shadowRoot!;
    const search = catalogRoot.querySelector('wa-input') as HTMLElement & {
      value: string;
    };
    search.value = 'manuscript';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(panel);
    expect(
      [...catalogRoot.querySelectorAll('.catalog-row-name')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['writer', 'reviewer']);
    catalogRoot
      .querySelector('.catalog-row-select')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    await settle(panel);
    expect(root.querySelector('#catalog-detail-name')?.textContent).toContain(
      'reviewer',
    );
    search.value = 'no matching agent';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(panel);
    expect(catalogRoot.querySelectorAll('.catalog-row')).toHaveLength(0);
    expect(catalogRoot.textContent).toContain('No matching agents');
    expect(catalogRoot.querySelector('slot[name=detail]')).toBeNull();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
