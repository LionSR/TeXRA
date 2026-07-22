// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import type { SessionContextValue, TeamOptionData } from '@shared/schemas';

// Local imports - component type and context
import type { InstructionPanel } from '@webview/frontend/components/InstructionPanel';
import type { sessionContext } from '@webview/frontend/contexts/mainViewContexts';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import type { ContextProvider } from '@lit/context';

// @lit/context's request/provider event classes capture the global `Event`
// constructor at module-evaluation time, so every import that transitively
// pulls it in (the context definition, ContextProvider) must stay dynamic —
// evaluated only inside the hook below, after the jsdom globals are installed.
let ContextProviderCtor: typeof ContextProvider;
let mainViewSessionContext: typeof sessionContext;

function teamOption(
  value: string,
  overrides: Partial<TeamOptionData> = {},
): TeamOptionData {
  return {
    value,
    label: value,
    icon: 'bookmark',
    source: 'built-in',
    description: '',
    unavailableMembers: [],
    rootAgentName: null,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    sessionType: 'toolUse',
    launchTarget: 'agent',
    selectedTeamId: '',
    instruction: '',
    placeholder: 'Describe the edit…',
    workflowAgent: 'copy-editor',
    toolUseAgent: 'assistant',
    model: 'model-a',
    workflowAgentOptions: [],
    toolUseAgentOptions: [],
    modelOptions: [],
    teamOptions: [],
    isRecording: false,
    isPolishing: false,
    debugMode: false,
    isOrchestratorSelected: false,
    statusAnnouncement: '',
    ...overrides,
  };
}

const TEAM_SESSION = makeSession({
  launchTarget: 'team',
  selectedTeamId: 'physicist',
  teamOptions: [
    teamOption('physicist', { label: 'Physicist' }),
    teamOption('reviewers', {
      label: 'Reviewers',
      source: 'custom',
      disabled: true,
      disabledReason: 'Requires sign-in',
    }),
  ],
});

async function mountPanel(
  session: SessionContextValue,
  { showSessionHint = true }: { showSessionHint?: boolean } = {},
): Promise<InstructionPanel> {
  const wrapper = document.createElement('div');
  const provider = new ContextProviderCtor(wrapper, {
    context: mainViewSessionContext,
    initialValue: session,
  });
  // ContextProvider treats plain elements as dumb hosts: the context-request
  // listener is only attached on hostConnected(), which nothing calls for us.
  provider.hostConnected();
  const element = document.createElement(
    'instruction-panel',
  ) as InstructionPanel;
  element.showSessionHint = showSessionHint;
  wrapper.append(element);
  document.body.append(wrapper);
  await element.updateComplete;
  return element;
}

function query<T extends HTMLElement>(
  element: InstructionPanel,
  selector: string,
): T | null {
  return element.shadowRoot?.querySelector<T>(selector) ?? null;
}

function recordEvents(
  element: HTMLElement,
  types: readonly string[],
): { type: string; detail: unknown }[] {
  const events: { type: string; detail: unknown }[] = [];
  for (const type of types) {
    element.addEventListener(type, (event) => {
      events.push({ type, detail: (event as CustomEvent).detail });
    });
  }
  return events;
}

/** Simulate a committed value change on a Web Awesome form control. */
function changeValue(element: HTMLElement, value: string): void {
  (element as unknown as { value: string }).value = value;
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/**
 * Rendering contract for the Agent/Team launcher (Design Concept A): the
 * panel swaps its picker, execute-button label, model-picker label, and
 * session hint off `session.launchTarget`, and the team select must
 * intercept the "Manage teams…" sentinel instead of treating it as a team.
 */
describe('instruction-panel launcher', () => {
  let BROWSE_ALL_AGENTS_OPTION_VALUE: string;
  let MANAGE_TEAMS_OPTION_VALUE: string;

  useLitComponentTestDom(async () => {
    // selectTemplates registers wa-option at module scope and @lit/context
    // captures the global Event constructor, so both can only be imported
    // after the test DOM globals are installed (this hook's job).
    ({ ContextProvider: ContextProviderCtor } = await import('@lit/context'));
    ({ sessionContext: mainViewSessionContext } =
      await import('@webview/frontend/contexts/mainViewContexts'));
    ({ BROWSE_ALL_AGENTS_OPTION_VALUE, MANAGE_TEAMS_OPTION_VALUE } =
      await import('@shared/utils/selectTemplates'));
    await import('@webview/frontend/components/InstructionPanel');
  });

  describe('agent launcher', () => {
    it('renders the launch-target toggle bound to the session with the interactive agent picker active', async () => {
      const element = await mountPanel(makeSession());

      const toggle = query<HTMLElement>(element, '#launchTargetToggle');
      expect(toggle).toBeTruthy();
      expect((toggle as unknown as { value: string }).value).toBe('agent');

      expect(query(element, '#toolUseAgent')).toBeTruthy();
      expect(query(element, '#agentSettingsButton')).toBeTruthy();
      // Cross-fade renders both panes; in agent mode the team pane is hidden
      // via opacity, not removed from DOM.
      expect(
        query(element, '.launcher-picker-fade')?.classList.contains(
          'agent-picker-visible',
        ),
      ).toBe(true);
      expect(query(element, '#teamPicker')).toBeTruthy();
      expect(query(element, '#teamSettingsButton')).toBeTruthy();
    });

    it('shows the workflow agent picker in workflow sessions', async () => {
      const element = await mountPanel(
        makeSession({ sessionType: 'workflow' }),
      );

      expect(query(element, '#workflowAgent')).toBeTruthy();
      expect(query(element, '#toolUseAgent')).toBeNull();
    });

    it('intercepts the browse-all-agents sentinel: restores the current agent and opens the catalog instead of an agent-change', async () => {
      const element = await mountPanel(
        makeSession({
          toolUseAgent: 'assistant',
          // The reset target must exist among the rendered options — wa-select
          // coerces values with no matching wa-option to null.
          toolUseAgentOptions: [{ value: 'assistant', label: 'Assistant' }],
        }),
      );
      const events = recordEvents(element, [
        'agent-change',
        'browse-all-agents',
      ]);

      const select = query<HTMLElement>(element, '#toolUseAgent');
      changeValue(select!, BROWSE_ALL_AGENTS_OPTION_VALUE);

      expect(events).toEqual([{ type: 'browse-all-agents', detail: null }]);
      expect((select as unknown as { value: string }).value).toBe('assistant');
    });
  });

  describe('launch-target toggle', () => {
    it('dispatches launch-target-change when the toggle value changes', async () => {
      const element = await mountPanel(makeSession());
      const events = recordEvents(element, ['launch-target-change']);

      const toggle = query<HTMLElement>(element, '#launchTargetToggle');
      changeValue(toggle!, 'team');

      expect(events).toEqual([
        { type: 'launch-target-change', detail: { value: 'team' } },
      ]);
    });
  });

  describe('team launcher', () => {
    it('renders the team picker with options and the manage-teams sentinel, hiding the agent picker', async () => {
      const element = await mountPanel(TEAM_SESSION);

      const picker = query<HTMLElement>(element, '#teamPicker');
      expect(picker).toBeTruthy();
      expect((picker as unknown as { value: string }).value).toBe('physicist');
      expect(query(element, '#teamSettingsButton')).toBeTruthy();
      // Cross-fade renders both panes simultaneously; in team mode the agent
      // pane is hidden via opacity, not removed from the DOM.
      expect(
        query(element, '.launcher-picker-fade')?.classList.contains(
          'team-picker-visible',
        ),
      ).toBe(true);
      expect(query(element, '#toolUseAgent')).toBeTruthy();
      expect(query(element, '#agentSettingsButton')).toBeTruthy();

      const options = [
        ...(element.shadowRoot?.querySelectorAll('#teamPicker wa-option') ??
          []),
      ];
      // Two teams plus the sentinel tail item.
      expect(options.length).toBe(3);
      expect(options[2]?.getAttribute('value')).toBe(MANAGE_TEAMS_OPTION_VALUE);

      const disabledOption = options.find(
        (option) => option.getAttribute('value') === 'reviewers',
      );
      expect(disabledOption?.hasAttribute('disabled')).toBe(true);
      expect(disabledOption?.getAttribute('title')).toContain(
        'Requires sign-in',
      );
      expect(disabledOption?.getAttribute('aria-label')).toBe(
        'Reviewers, custom team',
      );
    });

    it('dispatches team-change when a team is picked', async () => {
      const element = await mountPanel(TEAM_SESSION);
      const events = recordEvents(element, ['team-change']);

      const picker = query<HTMLElement>(element, '#teamPicker');
      changeValue(picker!, 'physicist');

      expect(events).toEqual([
        { type: 'team-change', detail: { value: 'physicist' } },
      ]);
    });

    it('intercepts the manage-teams sentinel: restores the current selection and dispatches manage-teams instead of team-change', async () => {
      const element = await mountPanel(TEAM_SESSION);
      const events = recordEvents(element, ['team-change', 'manage-teams']);

      const picker = query<HTMLElement>(element, '#teamPicker');
      changeValue(picker!, MANAGE_TEAMS_OPTION_VALUE);

      expect(events).toEqual([{ type: 'manage-teams', detail: null }]);
      expect((picker as unknown as { value: string }).value).toBe('physicist');
    });

    it('dispatches team-settings from the team settings button', async () => {
      const element = await mountPanel(TEAM_SESSION);
      const events = recordEvents(element, ['team-settings']);

      query<HTMLElement>(element, '#teamSettingsButton')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );

      expect(events).toEqual([{ type: 'team-settings', detail: null }]);
    });

    it('labels the execute button "Run team" and the model picker "Lead model"', async () => {
      const element = await mountPanel(TEAM_SESSION);

      expect(
        query<HTMLElement>(
          element,
          '.execute-button__label',
        )?.textContent?.trim(),
      ).toBe('Run team');
      expect(query(element, '#model')?.getAttribute('aria-label')).toBe(
        'Lead model',
      );
    });
  });

  describe('agent launcher labels', () => {
    it('labels the execute button "Run" and the model picker "Model"', async () => {
      const element = await mountPanel(makeSession());

      expect(
        query<HTMLElement>(
          element,
          '.execute-button__label',
        )?.textContent?.trim(),
      ).toBe('Run');
      expect(query(element, '#model')?.getAttribute('aria-label')).toBe(
        'Model',
      );
    });
  });

  describe('session hint', () => {
    it('prefers the team hint over the orchestrator hint when the team launcher is active', async () => {
      const element = await mountPanel(
        makeSession({ ...TEAM_SESSION, isOrchestratorSelected: true }),
      );

      const hint = query<HTMLElement>(element, 'wa-callout.session-hint');
      expect(hint?.getAttribute('data-hint-key')).toBe('team');
      expect(
        hint?.querySelector('.session-hint-lede')?.textContent?.trim(),
      ).toBe('Team run.');
      // The team hint has no timing guidance, so the time span is omitted.
      expect(hint?.querySelector('.session-hint-time')).toBeNull();
    });

    it('shows the orchestrator hint for interactive sessions with an orchestrator agent', async () => {
      const element = await mountPanel(
        makeSession({ isOrchestratorSelected: true }),
      );

      const hint = query<HTMLElement>(element, 'wa-callout.session-hint');
      expect(hint?.getAttribute('data-hint-key')).toBe('orchestrator');
    });

    it('falls back to the session-type hint for plain sessions', async () => {
      const interactive = await mountPanel(makeSession());
      expect(
        query<HTMLElement>(
          interactive,
          'wa-callout.session-hint',
        )?.getAttribute('data-hint-key'),
      ).toBe('toolUse');

      const workflow = await mountPanel(
        makeSession({ sessionType: 'workflow' }),
      );
      expect(
        query<HTMLElement>(workflow, 'wa-callout.session-hint')?.getAttribute(
          'data-hint-key',
        ),
      ).toBe('workflow');
    });

    it('dispatches dismiss-session-hint from the dismiss button', async () => {
      const element = await mountPanel(makeSession());
      const events = recordEvents(element, ['dismiss-session-hint']);

      query<HTMLElement>(element, '#dismissSessionHintButton')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );

      expect(events).toEqual([{ type: 'dismiss-session-hint', detail: null }]);
    });

    it('renders no hint when showSessionHint is false', async () => {
      const element = await mountPanel(TEAM_SESSION, {
        showSessionHint: false,
      });

      expect(query(element, 'wa-callout.session-hint')).toBeNull();
    });
  });

  describe('model picker focus copy', () => {
    it('names the team lead as the model owner for team sessions and the agent otherwise', async () => {
      const teamPanel = await mountPanel(TEAM_SESSION);
      const teamEvents = recordEvents(teamPanel, ['focus-instruction']);
      // Focus events do not bubble; dispatch directly on the select.
      query<HTMLElement>(teamPanel, '#model')?.dispatchEvent(
        new Event('focus'),
      );
      expect(teamEvents).toEqual([
        {
          type: 'focus-instruction',
          detail: {
            key: 'modelPicker',
            text: 'Choose the AI model used by the team lead.',
          },
        },
      ]);

      const agentPanel = await mountPanel(makeSession());
      const agentEvents = recordEvents(agentPanel, ['focus-instruction']);
      query<HTMLElement>(agentPanel, '#model')?.dispatchEvent(
        new Event('focus'),
      );
      expect(agentEvents).toEqual([
        {
          type: 'focus-instruction',
          detail: {
            key: 'modelPicker',
            text: 'Choose the AI model used by the selected agent.',
          },
        },
      ]);
    });
  });

  describe('status announcement', () => {
    it('mirrors the session announcement in the aria-live region', async () => {
      const element = await mountPanel(
        makeSession({ statusAnnouncement: 'Team launcher selected.' }),
      );

      expect(
        query<HTMLElement>(
          element,
          '[aria-live="polite"]',
        )?.textContent?.trim(),
      ).toBe('Team launcher selected.');
    });
  });
});
