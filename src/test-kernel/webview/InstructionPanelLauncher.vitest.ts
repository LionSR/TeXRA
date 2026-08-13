// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { InstructionPanel } from '@webview/frontend/components/InstructionPanel';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import {
  loadInstructionPanelModules,
  makeSession,
  mountInstructionPanel as mountPanel,
  teamOption,
  updateInstructionPanelSession as updatePanelSession,
} from './mainViewTestUtils';

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
 * Cross-fade renders both picker panes simultaneously; the inactive pane is
 * hidden via opacity and inert/aria-hidden, not removed from the DOM.
 */
function expectVisiblePane(
  element: InstructionPanel,
  visible: 'agent' | 'team',
): void {
  const hidden = visible === 'agent' ? 'team' : 'agent';
  expect(
    query(element, '.launcher-picker-fade')?.classList.contains(
      `${visible}-picker-visible`,
    ),
  ).toBe(true);
  expect(query(element, `.${visible}-picker-pane`)?.hasAttribute('inert')).toBe(
    false,
  );
  expect(
    query(element, `.${visible}-picker-pane`)?.getAttribute('aria-hidden'),
  ).toBe('false');
  expect(query(element, `.${hidden}-picker-pane`)?.hasAttribute('inert')).toBe(
    true,
  );
  expect(
    query(element, `.${hidden}-picker-pane`)?.getAttribute('aria-hidden'),
  ).toBe('true');
}

function expectLauncherLabels(
  element: InstructionPanel,
  modelLabel: string,
): void {
  expect(
    query<HTMLElement>(element, '#executeButton')?.getAttribute('aria-label'),
  ).toBe('Run agent');
  expect(query(element, '#model')?.getAttribute('aria-label')).toBe(modelLabel);
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
    // selectTemplates registers wa-option at module scope, so like the panel
    // modules loaded above it can only be imported after the test DOM globals
    // are installed (this hook's job).
    await loadInstructionPanelModules();
    ({ BROWSE_ALL_AGENTS_OPTION_VALUE, MANAGE_TEAMS_OPTION_VALUE } =
      await import('@shared/utils/selectTemplates'));
  });

  describe('agent launcher', () => {
    it('renders the launch-target toggle bound to the session with the interactive agent picker active', async () => {
      const element = await mountPanel(makeSession());

      const toggle = query<HTMLElement>(element, '#launchTargetToggle');
      expect(toggle).toBeTruthy();
      expect((toggle as unknown as { value: string }).value).toBe('agent');

      expect(query(element, '#toolUseAgent')).toBeTruthy();
      expect(query(element, '#agentSettingsButton')).toBeTruthy();
      expect(query(element, '#teamPicker')).toBeTruthy();
      expect(query(element, '#teamSettingsButton')).toBeTruthy();
      expectVisiblePane(element, 'agent');
    });

    it('shows the workflow agent picker directly without the launch-target toggle', async () => {
      const element = await mountPanel(
        makeSession({ sessionType: 'workflow' }),
      );

      expect(query(element, '#launchTargetToggle')).toBeNull();
      expect(query(element, '#workflowAgent')).toBeTruthy();
      expect(query(element, '#agentSettingsButton')).toBeTruthy();
      expect(query(element, '#toolUseAgent')).toBeNull();
      expect(query(element, '#teamPicker')).toBeNull();
      expect(query(element, '#teamSettingsButton')).toBeNull();
    });

    it('ignores stale team state when rendering a workflow launcher', async () => {
      const element = await mountPanel(
        makeSession({ sessionType: 'workflow', launchTarget: 'team' }),
      );

      expect(query(element, '#launchTargetToggle')).toBeNull();
      expect(query(element, '#workflowAgent')).toBeTruthy();
      expect(query(element, '#teamPicker')).toBeNull();
      expect(query(element, '#model')?.getAttribute('aria-label')).toBe(
        'Model',
      );
      expect(
        query(element, 'wa-callout.session-hint')?.getAttribute(
          'data-hint-key',
        ),
      ).toBe('workflow');
    });

    it('intercepts the browse-all-agents sentinel: restores the current agent and opens the catalog instead of an agent-change', async () => {
      const element = await mountPanel(
        makeSession({
          agent: { workflow: 'copy-editor', toolUse: 'assistant' },
          // The reset target must exist among the rendered options — wa-select
          // coerces values with no matching wa-option to null.
          agentOptions: {
            workflow: [],
            toolUse: [{ value: 'assistant', label: 'Assistant' }],
          },
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
    it('reconciles the hidden picker from Agent with no team to Team with a normalized selection', async () => {
      const initialSession = makeSession();
      const element = await mountPanel(initialSession);

      await updatePanelSession(element, {
        ...initialSession,
        teamOptions: TEAM_SESSION.teamOptions,
      });
      await updatePanelSession(element, TEAM_SESSION);

      const picker = query<HTMLElement>(element, '#teamPicker');
      expect(
        element.shadowRoot?.querySelectorAll('#teamPicker wa-option'),
      ).toHaveLength(3);
      expect((picker as unknown as { value: string }).value).toBe('physicist');
    });

    it('renders the team picker with options and the manage-teams sentinel, hiding the agent picker', async () => {
      const element = await mountPanel(TEAM_SESSION);

      const picker = query<HTMLElement>(element, '#teamPicker');
      expect(picker).toBeTruthy();
      expect((picker as unknown as { value: string }).value).toBe('physicist');
      expect(query(element, '#teamSettingsButton')).toBeTruthy();
      expect(query(element, '#toolUseAgent')).toBeTruthy();
      expect(query(element, '#agentSettingsButton')).toBeTruthy();
      expectVisiblePane(element, 'team');

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

    it('does not show instructional copy when the team picker receives focus', async () => {
      const element = await mountPanel(TEAM_SESSION);
      const events = recordEvents(element, ['focus-instruction']);

      query<HTMLElement>(element, '#teamPicker')?.dispatchEvent(
        new Event('focus'),
      );

      expect(events).toEqual([]);
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

    it('labels the execute action and the lead model picker', async () => {
      expectLauncherLabels(await mountPanel(TEAM_SESSION), 'Lead model');
    });
  });

  describe('agent launcher labels', () => {
    it('labels the execute action and the model picker', async () => {
      expectLauncherLabels(await mountPanel(makeSession()), 'Model');
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
