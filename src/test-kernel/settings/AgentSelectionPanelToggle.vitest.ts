import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@texra/shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AGENT_SOURCE } from '@shared/schemas';
import type { AgentSelectionItem } from '@texra/shared/settingsView/settingsViewMessages';
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

function renderAgentSelectionPanel(
  agents: AgentSelectionItem[] = [taskAgent],
): Promise<AgentSelectionPanelElement> {
  return mountComponent<AgentSelectionPanelElement>('agent-selection-panel', {
    agents,
  });
}

function queryToggle(
  panel: AgentSelectionPanelElement,
): HTMLElement & { checked?: boolean } {
  const toggle = panel.shadowRoot!.querySelector('.agent-list-item-toggle');
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
    panel
      .shadowRoot!.querySelector('.agent-list-item')
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
});
