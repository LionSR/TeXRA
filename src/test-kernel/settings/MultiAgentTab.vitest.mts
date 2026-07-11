// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { MultiAgentTab } from '@settingsView/frontend/tabs/MultiAgentTab';

// Local imports - shared schemas
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

// Local imports - test utilities
import { useLitComponentTestDom } from './litComponentTestUtils';

async function mount(
  props: Partial<MultiAgentTab> = {},
): Promise<MultiAgentTab> {
  const element = document.createElement('multi-agent-tab') as MultiAgentTab;
  Object.assign(element, props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

const CUSTOM_PRESET: AgentModePreset = {
  id: 'custom-team',
  name: 'Custom Team',
  description: 'A user-authored team.',
  icon: 'rocket',
  workflowAgents: ['polish'],
  toolUseAgents: ['assistant'],
};

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

/**
 * Regression coverage for the a11y-clickables audit: the team-preset card
 * was a plain `<div @click>` with no role/tabindex/keydown, so keyboard
 * users could never select a team even though `.preset-card:focus-visible`
 * already shipped an outline. Mirrors GoalTab.ts's `.goal-row` and
 * AgentSelectionPanel.ts's `.agent-list-item` keyboard-activation pattern.
 */
describe('multi-agent-tab preset card keyboard activation', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/tabs/MultiAgentTab'),
  );

  it('exposes role=button and tabindex=0 on every preset card', async () => {
    const element = await mount();
    const cards = element.shadowRoot?.querySelectorAll('.preset-card') ?? [];
    expect(cards.length).toBe(AGENT_MODE_PRESETS.length);
    for (const card of cards) {
      expect(card.getAttribute('role')).toBe('button');
      expect(card.getAttribute('tabindex')).toBe('0');
    }
  });

  it('applies the preset on Enter and Space, not on other keys', async () => {
    const element = await mount();
    const applied: string[] = [];
    element.addEventListener('apply-agent-mode-preset', (event) => {
      applied.push(
        (event as CustomEvent<{ presetId: string }>).detail.presetId,
      );
    });

    const firstCard = element.shadowRoot?.querySelector('.preset-card');
    expect(firstCard).toBeInstanceOf(HTMLElement);

    dispatchKey(firstCard!, 'a');
    expect(applied).toHaveLength(0);

    dispatchKey(firstCard!, 'Enter');
    dispatchKey(firstCard!, ' ');

    expect(applied).toEqual([
      AGENT_MODE_PRESETS[0]!.id,
      AGENT_MODE_PRESETS[0]!.id,
    ]);
  });

  it('does not apply the preset when Enter/Space bubbles from the delete button', async () => {
    const element = await mount({ customPresets: [CUSTOM_PRESET] });
    const applied: string[] = [];
    const deleted: string[] = [];
    element.addEventListener('apply-agent-mode-preset', (event) => {
      applied.push(
        (event as CustomEvent<{ presetId: string }>).detail.presetId,
      );
    });
    element.addEventListener('delete-agent-mode-preset', (event) => {
      deleted.push(
        (event as CustomEvent<{ presetId: string }>).detail.presetId,
      );
    });

    const deleteButton = element.shadowRoot?.querySelector(
      '.preset-delete-btn',
    );
    expect(deleteButton).toBeInstanceOf(HTMLElement);

    dispatchKey(deleteButton!, 'Enter');

    expect(applied).toHaveLength(0);
  });
});
