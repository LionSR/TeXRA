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
import { AGENT_MODE_PRESETS } from '@shared/schemas';
import type { AgentModePreset } from '@shared/schemas';

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

/**
 * Regression coverage for the a11y-clickables audit: the team-preset card
 * was a plain `<div @click>`, so keyboard users could never select a team.
 * Keep the apply action on a native button so browser keyboard behavior does
 * not depend on a hand-rolled key handler.
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

  it('renders every preset apply action as a native button', async () => {
    const element = await mount();
    const cards = element.shadowRoot?.querySelectorAll('.preset-card') ?? [];
    expect(cards.length).toBe(AGENT_MODE_PRESETS.length);
    for (const card of cards) {
      expect(card).toBeInstanceOf(HTMLButtonElement);
      expect(card.getAttribute('type')).toBe('button');
    }
  });

  it('applies the preset from its native button', async () => {
    const element = await mount();

    const firstCard = element.shadowRoot?.querySelector('.preset-card');
    expect(firstCard).toBeInstanceOf(HTMLButtonElement);
    (firstCard as HTMLButtonElement).click();

    expect(appliedPresetIds()).toEqual([AGENT_MODE_PRESETS[0]!.id]);
  });

  it('keeps the delete action separate from the preset button', async () => {
    const element = await mount({ customPresets: [CUSTOM_PRESET] });

    const deleteButton =
      element.shadowRoot?.querySelector('.preset-delete-btn');
    expect(deleteButton).toBeInstanceOf(HTMLElement);

    (deleteButton as HTMLElement).click();

    expect(appliedPresetIds()).toHaveLength(0);
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
      { presetId: CUSTOM_PRESET.id },
    );
  });

  /**
   * The card previously flipped a local `@state()` on click, so a team the
   * roster never adopted (cancelled sign-in, unavailable members) still read
   * as active, and a freshly opened Settings badged nothing at all.
   */
  it('badges the team the roster reports, not the one last clicked', async () => {
    const active = AGENT_MODE_PRESETS[1]!;
    const element = await mount({ activePresetId: active.id });

    const activeCards = element.shadowRoot?.querySelectorAll(
      '.preset-card.active',
    );
    expect(activeCards?.length).toBe(1);
    expect(activeCards?.[0]?.textContent).toContain(active.name);
    expect(activeCards?.[0]?.getAttribute('aria-pressed')).toBe('true');

    const otherCard = element.shadowRoot?.querySelector('.preset-card');
    (otherCard as HTMLElement).click();
    await element.updateComplete;

    expect(appliedPresetIds()).toEqual([AGENT_MODE_PRESETS[0]!.id]);
    expect(
      element.shadowRoot?.querySelector('.preset-card.active')?.textContent,
    ).toContain(active.name);
  });
});
