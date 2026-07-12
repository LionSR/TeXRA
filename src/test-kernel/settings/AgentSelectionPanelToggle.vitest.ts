import { describe, expect, it } from 'vitest';

import { AGENT_SOURCE } from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsView/data';
import { useLitComponentTestDom } from './litComponentTestUtils';

type AgentSelectionPanelElement = HTMLElement & {
  agents: AgentSelectionItem[];
  category: 'workflow' | 'toolUse';
  updateComplete: Promise<boolean>;
};

type AgentEnabledSetDetail = {
  agentName: string;
  agentSource: string;
  category: string;
  enabled: boolean;
};

const workflowAgent: AgentSelectionItem = {
  name: 'summarize',
  category: 'workflow',
  source: AGENT_SOURCE.BUILT_IN_WORKFLOW,
  hasPath: true,
  enabled: true,
};

async function renderAgentSelectionPanel(): Promise<AgentSelectionPanelElement> {
  const panel = document.createElement(
    'agent-selection-panel',
  ) as AgentSelectionPanelElement;
  panel.agents = [workflowAgent];
  panel.category = 'workflow';
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

describe('AgentSelectionPanel enabled toggle', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/AgentSelectionPanel'),
  );

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

  it('dispatches agent-enabled-set (not a click on the row) when the toggle is clicked', async () => {
    const panel = await renderAgentSelectionPanel();

    let detail: AgentEnabledSetDetail | undefined;
    let rowClicked = false;
    panel.addEventListener('agent-enabled-set', (event) => {
      detail = (event as CustomEvent<AgentEnabledSetDetail>).detail;
    });
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

    expect(detail).toEqual({
      agentName: 'summarize',
      agentSource: AGENT_SOURCE.BUILT_IN_WORKFLOW,
      category: 'workflow',
      enabled: false,
    });
    // The toggle's click handler stops propagation, so the row's own
    // click-to-select handler must not also fire.
    expect(rowClicked).toBe(false);
  });
});
