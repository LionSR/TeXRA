import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AGENT_SOURCE } from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsView/data';
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type AgentSelectionPanelElement = HTMLElement & {
  agents: AgentSelectionItem[];
  category: 'workflow' | 'toolUse';
  updateComplete: Promise<boolean>;
};

const workflowAgent: AgentSelectionItem = {
  name: 'summarize',
  category: 'workflow',
  source: AGENT_SOURCE.BUILT_IN_WORKFLOW,
  hasPath: true,
  enabled: true,
};

function renderAgentSelectionPanel(): Promise<AgentSelectionPanelElement> {
  return mountComponent<AgentSelectionPanelElement>('agent-selection-panel', {
    agents: [workflowAgent],
    category: 'workflow',
  });
}

describe('AgentSelectionPanel enabled toggle', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/AgentSelectionPanel'),
  );

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('renders the per-agent enabled toggle as wa-switch, not wa-checkbox', async () => {
    const panel = await renderAgentSelectionPanel();

    expect(panel.shadowRoot!.querySelector('wa-checkbox')).toBeNull();
    const toggle = panel.shadowRoot!.querySelector(
      '.agent-list-item-toggle',
    ) as HTMLElement & { checked?: boolean };

    expect(toggle).not.toBeNull();
    expect(toggle.tagName.toLowerCase()).toBe('wa-switch');
    expect(toggle.checked).toBe(true);
  });

  it('posts setAgentEnabled (not a click on the row) when the toggle is clicked', async () => {
    const panel = await renderAgentSelectionPanel();

    let rowClicked = false;
    panel
      .shadowRoot!.querySelector('.agent-list-item')
      ?.addEventListener('click', () => {
        rowClicked = true;
      });

    const toggle = panel.shadowRoot!.querySelector(
      '.agent-list-item-toggle',
    ) as HTMLElement;
    toggle.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
        {
          agentName: 'summarize',
          agentSource: AGENT_SOURCE.BUILT_IN_WORKFLOW,
          category: 'workflow',
          enabled: false,
        },
      ],
    ]);
    // The toggle's click handler stops propagation, so the row's own
    // click-to-select handler must not also fire.
    expect(rowClicked).toBe(false);
  });
});
