// Desktop first-run tour.
//
// This replaced a static four-step list of instructions. The problem it solved:
// TeXRA already ships five discipline teams (Lean, physics, math, CS/ML,
// software engineering), each declaring its own workflow agents, tool-use
// agents, and per-agent tool lists — but that whole system was reachable only
// through Settings tab index 4, so a new user never saw it and landed on a
// generic roster. The capability existed; the discoverability didn't.
//
// So the tour leads with the question that actually configures the app: what
// kind of work are you doing? The answer selects a team, which is applied
// through the same `applyAgentModePreset` path the Settings team picker uses —
// no parallel configuration mechanism.
//
// Steps: pick your work → confirm the preset roster → finish (open the
// launcher). Users who want to skip can dismiss at any step.

import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, render, nothing, type TemplateResult } from 'lit';

import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { waIcon, type TeXRAIconName } from '@shared/wa/webAwesomeIcons';

import { isCommandPaletteShortcut } from './desktopCommandPalette';
import type { DesktopRoute } from '../desktopShellMessages';

interface WalkthroughDialogController {
  element: HTMLElement;
  isVisible(): boolean;
  show(): void;
  hide(): void;
}

export interface DesktopFirstRunWalkthroughOptions {
  document: Document;
  dismiss(): void;
  setRoute(route: DesktopRoute): void;
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
    icon: 'symbol-operator',
  },
  {
    presetId: 'mathematician',
    question: 'Proving mathematics',
    detail: 'Open problems, proofs, Lean formalization, LaTeX correction.',
    icon: 'symbol-number',
  },
  {
    presetId: 'cs-ml',
    question: 'Writing a CS or ML paper',
    detail: 'Algorithms, experiments and ablations, tests, review.',
    icon: 'symbol-method',
  },
  {
    presetId: 'lean-project',
    question: 'Formalizing in Lean 4',
    detail: 'Theorem search, tactic simplification, blueprints.',
    icon: 'symbol-structure',
  },
  {
    presetId: 'software-engineer',
    question: 'Building software',
    detail: 'Implementation, review, debugging, and tests across a team.',
    icon: 'tools',
  },
];

type TourStep = 'work' | 'roster' | 'done';

// Each createFirstRunWalkthrough() call grabs a unique id so two co-existing
// dialogs cannot collide on aria-labelledby.
let walkthroughTitleCounter = 0;

function nextWalkthroughTitleId(): string {
  walkthroughTitleCounter += 1;
  return `walkthrough-title-${walkthroughTitleCounter}`;
}

function presetById(presetId: string): AgentModePreset | undefined {
  return AGENT_MODE_PRESETS.find((preset) => preset.id === presetId);
}

export function createFirstRunWalkthrough({
  document,
  dismiss: postDismissed,
  setRoute,
  openMultiAgent,
}: DesktopFirstRunWalkthroughOptions): WalkthroughDialogController {
  const titleId = nextWalkthroughTitleId();
  const dialog = document.createElement('wa-dialog');
  dialog.classList.add('desktop-onboarding');
  dialog.withoutHeader = true;
  dialog.setAttribute('aria-labelledby', titleId);

  // Distinguishes user-initiated close (Escape / button click) — which fires
  // the dismissed callback back to the host — from programmatic close from
  // hide(), which would otherwise feedback-loop with host state syncs.
  let suppressNextPost = false;
  let step: TourStep = 'work';
  let chosenPresetId: string | undefined;

  const closeDialog = (): void => {
    dialog.open = false;
  };

  function goTo(next: TourStep): void {
    step = next;
    rerender();
  }

  function chooseWorkType(presetId: string): void {
    chosenPresetId = presetId;
    // Apply immediately through the same command the Settings team picker
    // uses, so the roster is live even if the user dismisses the tour here.
    postMessage(SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET, { presetId });
    goTo('roster');
  }

  function workStepTemplate(): TemplateResult {
    return html`
      <header class="desktop-onboarding-header">
        ${waIcon('wand-magic-sparkles', {
          className: 'desktop-onboarding-icon',
        })}
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
            <button
              type="button"
              class="desktop-onboarding-choice"
              @click=${() => chooseWorkType(entry.presetId)}
            >
              ${waIcon(entry.icon, { className: 'desktop-onboarding-choice-icon' })}
              <span class="desktop-onboarding-choice-text">
                <strong>${entry.question}</strong>
                <span>${entry.detail}</span>
              </span>
            </button>
          `,
        )}
      </div>
      <div slot="footer" class="desktop-onboarding-actions">
        <wa-button
          class="desktop-secondary-button"
          appearance="plain"
          @click=${closeDialog}
        >
          Skip for now
        </wa-button>
      </div>
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
      preset.workflowAgents.length + preset.toolUseAgents.length;
    return html`
      <header class="desktop-onboarding-header">
        ${waIcon('circle-check', { className: 'desktop-onboarding-icon' })}
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
          preset.workflowAgents.length > 0
            ? html`
                <div class="desktop-onboarding-roster-group">
                  <span class="desktop-onboarding-roster-label">Workflows</span>
                  <div class="desktop-onboarding-roster-chips">
                    ${preset.workflowAgents.map(
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
            ${preset.toolUseAgents.map(
              (name) =>
                html`<span class="desktop-onboarding-chip">${name}</span>`,
            )}
          </div>
        </div>
      </div>
      <div slot="footer" class="desktop-onboarding-actions">
        <wa-button
          class="desktop-secondary-button"
          appearance="outlined"
          @click=${() => goTo('work')}
        >
          Back
        </wa-button>
        <wa-button
          class="desktop-secondary-button"
          appearance="outlined"
          @click=${() => {
            closeDialog();
            openMultiAgent();
          }}
        >
          Customize
        </wa-button>
        <wa-button
          class="desktop-primary-button"
          appearance="filled"
          variant="brand"
          data-walkthrough-primary
          @click=${() => goTo('done')}
        >
          Continue
        </wa-button>
      </div>
    `;
  }

  function doneStepTemplate(): TemplateResult {
    return html`
      <header class="desktop-onboarding-header">
        ${waIcon('rocket', { className: 'desktop-onboarding-icon' })}
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
              Sign in for included access, or add your own provider keys in
              Settings.
            </span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">2</span>
          <div>
            <strong>Tabs</strong>
            <span>
              Open an editor, terminal, browser, or Settings from the + button.
              They stay open beside a running agent.
            </span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">3</span>
          <div>
            <strong>Commands</strong>
            <span>
              Press the Commands button for every action and shortcut.
            </span>
          </div>
        </li>
      </ol>
      <div slot="footer" class="desktop-onboarding-actions">
        <wa-button
          class="desktop-secondary-button"
          appearance="outlined"
          @click=${() => goTo('roster')}
        >
          Back
        </wa-button>
        <wa-button
          class="desktop-primary-button"
          appearance="filled"
          variant="brand"
          data-walkthrough-primary
          @click=${() => {
            closeDialog();
            setRoute('main');
          }}
        >
          Start working
        </wa-button>
      </div>
    `;
  }

  const STEP_TEMPLATES: Record<TourStep, () => TemplateResult> = {
    work: workStepTemplate,
    roster: rosterStepTemplate,
    done: doneStepTemplate,
  };

  function rerender(): void {
    render(STEP_TEMPLATES[step](), dialog);
    // Re-focus the step's primary action after each render so keyboard users
    // can advance with Enter without tabbing.
    dialog.querySelector<HTMLElement>('[data-walkthrough-primary]')?.focus();
  }

  rerender();

  // wa-dialog handles modal backdrop, focus trap, escape key, and focus
  // restoration automatically. Reapply the previous "primary action focused
  // first" policy so keyboard users can advance with one Enter, and intercept
  // the command-palette shortcut so it does not fire while the dialog is open.
  dialog.addEventListener('wa-after-show', () => {
    dialog.querySelector<HTMLElement>('[data-walkthrough-primary]')?.focus();
  });
  // Every user-initiated dismissal (Escape, footer buttons) posts the
  // dismissed signal back to the host. Programmatic hide() suppresses the
  // post via suppressNextPost to avoid a feedback loop with state messages.
  dialog.addEventListener('wa-after-hide', () => {
    if (suppressNextPost) {
      suppressNextPost = false;
      return;
    }
    postDismissed();
  });
  // Scoped to the dialog so it only runs while open and only for keys that
  // originate inside it. stopPropagation prevents the global command-palette
  // listener (on document) from firing.
  dialog.addEventListener('keydown', (event) => {
    if (isCommandPaletteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  return {
    element: dialog,
    isVisible: () => dialog.open,
    show: () => {
      dialog.open = true;
    },
    hide: () => {
      if (!dialog.open) return;
      suppressNextPost = true;
      dialog.open = false;
    },
  };
}
