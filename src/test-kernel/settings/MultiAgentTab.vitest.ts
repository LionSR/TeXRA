// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports
import type { MultiAgentTab } from '@settingsView/frontend/tabs/MultiAgentTab';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

// Local file imports
import {
  dispatchKey,
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

function mount(props: Partial<MultiAgentTab> = {}): Promise<MultiAgentTab> {
  return mountComponent<MultiAgentTab>('multi-agent-tab', props);
}

const CUSTOM_PRESET: AgentModePreset = {
  id: 'custom-team',
  name: 'Custom Team',
  description: 'A user-authored team.',
  icon: 'rocket',
  agents: {
    workflow: ['polish'],
    toolUse: ['assistant'],
  },
};

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

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  /** presetIds from applyAgentModePreset postMessage calls, in order. */
  function appliedPresetIds(): string[] {
    return mocks.postMessage.mock.calls
      .filter(
        ([command]) =>
          command === SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
      )
      .map(([, payload]) => (payload as { presetId: string }).presetId);
  }

  it('exposes concise keyboard controls for every preset card', async () => {
    const element = await mount();
    const cards = element.shadowRoot?.querySelectorAll('.preset-card') ?? [];
    expect(cards.length).toBe(AGENT_MODE_PRESETS.length);
    for (const [index, card] of [...cards].entries()) {
      expect(card.getAttribute('role')).toBe('button');
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(card.getAttribute('aria-label')).toBe(
        `Apply ${AGENT_MODE_PRESETS[index]!.name} team`,
      );
    }
  });

  it('applies the preset on Enter and Space, not on other keys', async () => {
    const element = await mount();

    const firstCard = element.shadowRoot?.querySelector('.preset-card');
    expect(firstCard).toBeInstanceOf(HTMLElement);

    dispatchKey(firstCard!, 'a');
    expect(appliedPresetIds()).toHaveLength(0);

    dispatchKey(firstCard!, 'Enter');
    dispatchKey(firstCard!, ' ');

    expect(appliedPresetIds()).toEqual([
      AGENT_MODE_PRESETS[0]!.id,
      AGENT_MODE_PRESETS[0]!.id,
    ]);
  });

  it('does not apply the preset when Enter/Space bubbles from the delete button', async () => {
    const element = await mount({ customPresets: [CUSTOM_PRESET] });

    const deleteButton =
      element.shadowRoot?.querySelector('.preset-delete-btn');
    expect(deleteButton).toBeInstanceOf(HTMLElement);

    dispatchKey(deleteButton!, 'Enter');

    expect(appliedPresetIds()).toHaveLength(0);
  });

  it('uses the backend capability list as the only orchestrator authority', async () => {
    const element = await mount({
      customPresets: [
        {
          ...CUSTOM_PRESET,
          agents: { workflow: [], toolUse: ['named-orchestrator'] },
        },
      ],
      orchestratorAgents: [],
    });

    const customCard = element.shadowRoot
      ?.querySelectorAll('.preset-card')
      .item(AGENT_MODE_PRESETS.length);
    expect(
      customCard?.querySelectorAll('.preset-agent-badge--orchestrator'),
    ).toHaveLength(0);
    expect(
      customCard?.querySelector('.preset-card-agents')?.textContent,
    ).toContain('named-orchestrator');
  });
});
