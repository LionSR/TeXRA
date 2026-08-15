// Desktop startup team panel.
//
// This replaced a static four-step list of instructions. The problem it solved:
// TeXRA already ships five discipline teams (Lean, physics, math, CS/ML,
// software engineering), each declaring its own workflow agents, tool-use
// agents, and per-agent tool lists — but that whole system was reachable only
// through Settings tab index 4, so a new user never saw it and landed on a
// generic roster. The capability existed; the discoverability didn't.
//
// The panel leads with the question that actually configures the app: what
// kind of work are you doing? The answer selects a team, which is applied
// through the same `applyAgentModePreset` path the Settings team picker uses —
// no parallel configuration mechanism.
//
// Steps: pick your work → confirm the preset roster → finish (open the
// launcher). It is shown in the task canvas at startup unless the user saves
// the "don't show" preference.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import { html, nothing, type TemplateResult } from 'lit';

import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { AGENT_MODE_PRESETS, type AgentModePreset } from '@shared/schemas';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { formatDesktopAccelerator } from '@shared/commands/accelerators';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { desktopCommandPaletteShortcut } from './desktopShortcutRegistry';
import { getRendererPlatform } from './rendererPlatform';

interface StartupPanelController {
  isVisible(): boolean;
  template(): TemplateResult | typeof nothing;
  show(): void;
  hide(): void;
}

export interface DesktopStartupTeamPanelOptions {
  dismiss(): void;
  onVisibilityChanged(): void;
  showLauncher(): void;
  /** Opens the Settings tab focused on the team picker, for fine-tuning. */
  openMultiAgent(): void;
}

/**
 * The work-type question. Each choice maps to a built-in team id from
 * {@link AGENT_MODE_PRESETS} — this is a friendlier phrasing of the same
 * choice, not a second taxonomy. `presetId` values must exist there; the
 * lookup below drops any that don't rather than applying a bad id.
 */
const WORK_TYPES: ReadonlyArray<{
  readonly presetId: string;
  readonly question: string;
  readonly detail: string;
  readonly icon: TeXRAIconName;
}> = [
  {
    presetId: 'physicist',
    question: 'Writing a physics paper',
    detail: 'Derivations, numerical checks, literature search, slides, review.',
    icon: 'cube',
  },
  {
    presetId: 'mathematician',
    question: 'Doing mathematics',
    detail: 'Open problems, proofs, Lean formalization, LaTeX correction.',
    icon: 'hashtag',
  },
  {
    presetId: 'cs-ml',
    question: 'Writing a CS or ML paper',
    detail: 'Algorithms, experiments and ablations, tests, review.',
    icon: 'cube',
  },
  {
    presetId: 'lean-project',
    question: 'Formalizing in Lean 4',
    detail: 'Theorem search, tactic simplification, blueprints.',
    icon: 'diagram-project',
  },
  {
    presetId: 'software-engineer',
    question: 'Building software',
    detail: 'Implementation, review, debugging, and tests across a team.',
    icon: 'screwdriver-wrench',
  },
];

type TourStep = 'work' | 'roster' | 'done';

// Each panel instance gets a unique heading id for aria-labelledby.
let panelTitleCounter = 0;

function nextPanelTitleId(): string {
  panelTitleCounter += 1;
  return `startup-team-title-${panelTitleCounter}`;
}

function presetById(presetId: string): AgentModePreset | undefined {
  return AGENT_MODE_PRESETS.find((preset) => preset.id === presetId);
}

export function createStartupTeamPanel({
  dismiss: postDismissed,
  onVisibilityChanged,
  showLauncher,
  openMultiAgent,
}: DesktopStartupTeamPanelOptions): StartupPanelController {
  const titleId = nextPanelTitleId();
  // The walkthrough names the Commands shortcut, so format it for the user's
  // platform rather than hardcoding the macOS glyph.
  const platform = getRendererPlatform(document.defaultView);
  const commandsAccelerator = formatDesktopAccelerator(
    desktopCommandPaletteShortcut(platform).accelerator,
    platform,
  );
  const commandsHint = commandsAccelerator ? ` (${commandsAccelerator})` : '';
  let visible = false;
  let hideAtStartup = false;
  let step: TourStep = 'work';
  let chosenPresetId: string | undefined;

  function closePanel(): void {
    visible = false;
    if (hideAtStartup) postDismissed();
    onVisibilityChanged();
  }

  function goTo(next: TourStep): void {
    step = next;
    onVisibilityChanged();
  }

  function chooseWorkType(presetId: string): void {
    chosenPresetId = presetId;
    // Apply immediately through the same command the Settings team picker
    // uses, so the roster is live even if the user dismisses the panel here.
    postMessage(SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET, { presetId });
    goTo('roster');
  }

  function workStepTemplate(): TemplateResult {
    return html`
      <header class="desktop-onboarding-header">
        <span class="desktop-onboarding-icon icon-surface is-size-l">
          ${waIcon('wand-magic-sparkles')}
        </span>
        <div>
          <h1 id=${titleId}>What are you working on?</h1>
          <p>
            TeXRA configures a team of agents, their tools, and their workflows
            for the kind of work you do. You can change any of it later.
          </p>
        </div>
      </header>
      <div class="desktop-onboarding-choices">
        ${WORK_TYPES.filter((entry) => presetById(entry.presetId)).map(
          (entry) => html`
            <wa-button
              class="desktop-onboarding-choice"
              appearance="outlined"
              size="l"
              @click=${() => chooseWorkType(entry.presetId)}
            >
              <span
                slot="start"
                class="desktop-onboarding-choice-icon icon-surface is-size-l"
              >
                ${waIcon(entry.icon)}
              </span>
              <span class="desktop-onboarding-choice-text">
                <strong>${entry.question}</strong>
                <span>${entry.detail}</span>
              </span>
            </wa-button>
          `,
        )}
      </div>
      ${footerTemplate(html`
        <wa-button
          class="btn-secondary"
          appearance="outlined"
          size="s"
          @click=${closePanel}
        >
          Skip for now
        </wa-button>
      `)}
    `;
  }

  function rosterStepTemplate(): TemplateResult {
    const preset = chosenPresetId ? presetById(chosenPresetId) : undefined;
    if (!preset) {
      // Defensive: chooseWorkType only advances for ids that resolve, so this
      // is unreachable in practice. Bail to the work step rather than render an
      // empty roster.
      return workStepTemplate();
    }
    const agentCount =
      preset.agents.workflow.length + preset.agents.toolUse.length;
    return html`
      <header class="desktop-onboarding-header">
        <span class="desktop-onboarding-icon icon-surface is-size-l">
          ${waIcon('circle-check')}
        </span>
        <div>
          <h1 id=${titleId}>${preset.name} team is ready</h1>
          <p>${preset.description}</p>
        </div>
      </header>
      <div class="desktop-onboarding-roster">
        <p class="desktop-onboarding-roster-summary">
          ${agentCount} agents enabled, each with its own tools and prompts.
        </p>
        ${
          preset.agents.workflow.length > 0
            ? html`
                <div class="desktop-onboarding-roster-group">
                  <span class="desktop-onboarding-roster-label">Workflows</span>
                  <div class="desktop-onboarding-roster-chips">
                    ${preset.agents.workflow.map(
                      (name) =>
                        html`<span class="desktop-onboarding-chip"
                          >${name}</span
                        >`,
                    )}
                  </div>
                </div>
              `
            : nothing
        }
        <div class="desktop-onboarding-roster-group">
          <span class="desktop-onboarding-roster-label">Agents</span>
          <div class="desktop-onboarding-roster-chips">
            ${preset.agents.toolUse.map(
              (name) =>
                html`<span class="desktop-onboarding-chip">${name}</span>`,
            )}
          </div>
        </div>
      </div>
      ${footerTemplate(html`
        <wa-button
          class="btn-secondary"
          appearance="outlined"
          size="s"
          @click=${() => goTo('work')}
        >
          Back
        </wa-button>
        <wa-button
          class="btn-secondary"
          appearance="outlined"
          size="s"
          @click=${() => {
            closePanel();
            openMultiAgent();
          }}
        >
          Customize
        </wa-button>
        <wa-button
          class="btn-primary"
          appearance="filled"
          variant="brand"
          size="s"
          data-walkthrough-primary
          @click=${() => goTo('done')}
        >
          Continue
        </wa-button>
      `)}
    `;
  }

  function doneStepTemplate(): TemplateResult {
    return html`
      <header class="desktop-onboarding-header">
        <span class="desktop-onboarding-icon icon-surface is-size-l">
          ${waIcon('rocket')}
        </span>
        <div>
          <h1 id=${titleId}>You're set up</h1>
          <p>Three things worth knowing before your first run.</p>
        </div>
      </header>
      <ol class="desktop-onboarding-steps">
        <li>
          <span class="desktop-onboarding-step-index">1</span>
          <div>
            <strong>Model access</strong>
            <span>
              Sign in for ${INCLUDED_ACCESS.inline}, or add
              ${OWN_API_KEYS.inline} in Settings.
            </span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">2</span>
          <div>
            <strong>Tabs</strong>
            <span>
              Open a terminal, browser, or Settings from the buttons at the
              bottom of the sidebar - or from Commands${commandsHint}. Open
              files from the project list; everything stays open beside a
              running agent.
            </span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">3</span>
          <div>
            <strong>Commands</strong>
            <span>
              Open Commands${commandsHint} from the header for every action and
              shortcut.
            </span>
          </div>
        </li>
      </ol>
      ${footerTemplate(html`
        <wa-button
          class="btn-secondary"
          appearance="outlined"
          size="s"
          @click=${() => goTo('roster')}
        >
          Back
        </wa-button>
        <wa-button
          class="btn-primary"
          appearance="filled"
          variant="brand"
          size="s"
          data-walkthrough-primary
          @click=${() => {
            closePanel();
            showLauncher();
          }}
        >
          Start working
        </wa-button>
      `)}
    `;
  }

  function footerTemplate(actions: TemplateResult): TemplateResult {
    return html`
      <div slot="footer" class="desktop-onboarding-actions">
        <wa-checkbox
          class="desktop-onboarding-startup-choice"
          size="s"
          .checked=${hideAtStartup}
          @change=${(event: Event) => {
            hideAtStartup = (
              event.currentTarget as HTMLElement & { checked: boolean }
            ).checked;
          }}
        >
          Don't show this at startup
        </wa-checkbox>
        <span class="desktop-onboarding-actions-spacer"></span>
        ${actions}
      </div>
    `;
  }

  const STEP_TEMPLATES: Record<TourStep, () => TemplateResult> = {
    work: workStepTemplate,
    roster: rosterStepTemplate,
    done: doneStepTemplate,
  };

  function panelTemplate(): TemplateResult {
    return html`
      <section
        class="desktop-startup-panel"
        aria-labelledby=${titleId}
        data-step=${step}
      >
        <wa-card
          class="desktop-onboarding"
          appearance="filled-outlined"
          with-footer
        >
          ${STEP_TEMPLATES[step]()}
        </wa-card>
      </section>
    `;
  }

  return {
    isVisible: () => visible,
    template: () => (visible ? panelTemplate() : nothing),
    show: () => {
      if (visible) return;
      visible = true;
      onVisibilityChanged();
    },
    hide: () => {
      if (!visible) return;
      visible = false;
      onVisibilityChanged();
    },
  };
}
