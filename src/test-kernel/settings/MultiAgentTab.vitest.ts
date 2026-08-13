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

describe('multi-agent-tab preset cards', () => {
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

  it('exposes a concise native button for every preset card', async () => {
    const element = await mount();
    const cards = element.shadowRoot?.querySelectorAll('.preset-card') ?? [];
    expect(cards.length).toBe(AGENT_MODE_PRESETS.length);
    for (const [index, card] of [...cards].entries()) {
      const applyButton = card.querySelector('.preset-apply-btn');
      expect(applyButton?.tagName).toBe('BUTTON');
      expect(applyButton?.getAttribute('aria-label')).toBe(
        `Apply ${AGENT_MODE_PRESETS[index]!.name} team`,
      );
      expect(applyButton?.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('applies the preset from its button', async () => {
    const element = await mount();
    const applyButton =
      element.shadowRoot?.querySelector<HTMLButtonElement>('.preset-apply-btn');

    applyButton?.click();

    expect(appliedPresetIds()).toEqual([AGENT_MODE_PRESETS[0]!.id]);
  });

  it('does not claim a team is active before the host confirms it', async () => {
    const element = await mount();
    const firstCard = element.shadowRoot?.querySelector('.preset-card');
    const applyButton =
      firstCard?.querySelector<HTMLButtonElement>('.preset-apply-btn');

    applyButton?.click();
    await element.updateComplete;

    expect(appliedPresetIds()).toEqual([AGENT_MODE_PRESETS[0]!.id]);
    expect(firstCard?.classList.contains('active')).toBe(false);
    expect(firstCard?.querySelector('.preset-active-badge')).toBeNull();
  });

  it('exposes the team confirmed by the host as active', async () => {
    const activePresetId = AGENT_MODE_PRESETS[0]!.id;
    const element = await mount({ activePresetId });
    const firstCard = element.shadowRoot?.querySelector('.preset-card');
    const applyButton = firstCard?.querySelector('.preset-apply-btn');

    expect(firstCard?.classList.contains('active')).toBe(true);
    expect(applyButton?.getAttribute('aria-pressed')).toBe('true');
    expect(firstCard?.querySelector('.preset-active-badge')).not.toBeNull();
  });

  it('keeps the custom-team delete button outside the apply button', async () => {
    const element = await mount({ customPresets: [CUSTOM_PRESET] });
    const customCard = element.shadowRoot
      ?.querySelectorAll('.preset-card')
      .item(AGENT_MODE_PRESETS.length);
    const applyButton = customCard?.querySelector('.preset-apply-btn');
    const deleteButton =
      customCard?.querySelector<HTMLElement>('.preset-delete-btn');
    expect(deleteButton).toBeInstanceOf(HTMLElement);
    expect(applyButton?.contains(deleteButton ?? null)).toBe(false);

    deleteButton?.click();

    expect(appliedPresetIds()).toHaveLength(0);
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
      { presetId: CUSTOM_PRESET.id },
    );
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
