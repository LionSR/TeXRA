/**
 * `<progress-app>`: the one conversation shell of the extension.
 * It is the root, the only element that holds the three records, and it
 * renders exactly one of two states from `shownRun(surface)`: the New task
 * empty state (hero, the context disclosure, the Active now strip, the
 * expanded composer) or the selected run's conversation, under one header
 * row: the run's own header when a run is selected. The Sessions drawer,
 * the docked list of the wide editor tab, and the Tools sheet hang off the
 * same element. Placed `embedded`, a host's own chrome around it lists
 * the tasks and owns New task, Settings and the window items, so the shell
 * renders none of them, nor the Sessions drawer or the Active now strip.
 *
 * `view`, `surface`, and `host` are properties: the design harness assigns
 * fixtures to them, and the live host assigns its signals to the same
 * names. Every send leaves as a `runtime-request`, `host-request`, or
 * `surface-action` event with the command as its detail;
 * `SessionSurfaces.listen` installs one listener per event.
 */

// Third-party imports
import { getBasename } from '@texra-ai/worldline/schemas';
import { String as Str } from 'effect';
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared webview
import '@ui/wa/spinner';
import { documentRevisionsOf } from '@texra/shared/plugins/documents';
import type { HostSnapshot } from '@texra/shared/session/hostSnapshot';
import { shownRun, type Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import {
  FILE_SELECT_CONFIGS,
  LAUNCH_FILE_LISTS,
} from '@ui/copy/fileSelectConfigs';
import { designTokens } from '@ui/styles';
import { texraGuideUrl } from '@ui/copy/guide';
import {
  renderIconActionButton,
  renderIconActionButtonParts,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { registerTeXRAWebAwesomeIcons, waIcon } from '@ui/wa/webAwesomeIcons';
import { ONBOARDING_SETUP_HANDOFF } from '@ui/copy/onboarding';
import { READ_GUIDE_BUTTON_LABEL } from '@ui/copy/instructionActions';
import { requestErrorText } from '@ui/copy/requestErrors';

// Local imports - progress view frontend
import { progressAppStyles } from './progressAppStyles';
import { renderTaskFilter, taskFilterStyles } from './components/taskFilter';
import './components/RunTabs';
import './components/RunConversation';
import './components/SessionBanners';
import './components/SessionComposer';
import './components/NewTaskHero';
import './components/LaunchAttachments';
import './components/SessionDrawer';
import './components/ToolsSheet';
import './components/FileSelectGroup';
import './components/GettingStartedBanner';
import './components/OnboardingWelcomeCard';
import './components/RunHeader';
import { editedProposal } from './proposalEdit';
import { actionMenu, type ActionMenuItem } from '@ui/wa/actionMenu';
import type { SessionView, RunView } from '@texra-ai/worldline/schemas';

registerTeXRAWebAwesomeIcons();

@customElement('progress-app')
export class ProgressApp extends LitElement {
  static override styles = [designTokens, progressAppStyles, taskFilterStyles];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** Fixed by the document hosting this surface: the VS Code sidebar, its
   *  editor tab, or `embedded` in a host whose own chrome lists the tasks
   *  and owns New task, Settings and the window's commands. */
  @property() placement: 'sidebar' | 'editor' | 'embedded' = 'sidebar';

  private selectNew = (): void => {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'selectNew' }));
  };

  private toggleDrawer = (): void => {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'toggleDrawer' }));
  };

  private onboarding(action: 'runSetup' | 'skipSetup'): void {
    this.dispatchEvent(SessionUiEvents.host({ kind: 'onboarding', action }));
  }

  /** The window's own items: pop the view out or back, the LaTeXDiffs
   *  sheet. The New-task header shows them in its menu; a run's header
   *  appends them to the run's. An embedded shell's host owns its window. */
  private windowItems(): ActionMenuItem[] {
    if (this.placement === 'embedded') return [];
    const inEditor = this.placement === 'editor';
    const host = (kind: 'popOut' | 'popBack') => () =>
      this.dispatchEvent(SessionUiEvents.host({ kind }));
    return [
      inEditor
        ? {
            icon: 'backward-step',
            label: 'Back to sidebar',
            activate: host('popBack'),
          }
        : {
            icon: 'picture-in-picture',
            label: 'Open tasks in editor',
            activate: host('popOut'),
          },
      {
        icon: 'code-compare',
        label: 'latexdiff…',
        activate: () =>
          this.dispatchEvent(
            SessionUiEvents.surface({ kind: 'toolsSheet', open: true }),
          ),
      },
    ];
  }

  override render(): TemplateResult | typeof nothing {
    const { view, surface, host } = this;
    if (!view || !surface || !host) return nothing;
    const selected = shownRun(surface);
    const run = selected === null ? null : (view.runs.get(selected) ?? null);
    const docked = this.placement === 'editor';

    return html`
      <div class=${classMap({ shell: true, 'is-editor': docked })}>
        ${this.renderHeader(run, host, surface, view)}
        <div class="shell-body">
          ${docked ? this.renderDockedList(view, surface) : nothing}
          <main class="reading">
            <div role="status" aria-live="polite">
              ${this.renderRequestError()}
            </div>
            ${
              run
                ? html`<run-conversation
                    .run=${run}
                    .view=${view}
                    .surface=${surface}
                    .host=${host}
                  ></run-conversation>`
                : this.renderEmptyState(view, surface, host)
            }
          </main>
        </div>
        ${
          surface.drawerOpen && this.placement !== 'embedded'
            ? html`<session-drawer
                .view=${view}
                .surface=${surface}
                .host=${host}
                .placement=${this.placement}
              ></session-drawer>`
            : nothing
        }
        ${
          surface.toolsSheetOpen
            ? html`<tools-sheet
                .surface=${surface}
                .host=${host}
              ></tools-sheet>`
            : nothing
        }
      </div>
    `;
  }

  private renderRequestError(): TemplateResult | typeof nothing {
    const error = this.surface?.requestError;
    if (!error) return nothing;
    return html`<wa-callout class="request-notice" variant="danger">
      ${waIcon('circle-exclamation', { slot: 'icon' })}
      <div class="request-notice-content">
        <div>
          ${requestErrorText(error)}
          ${
            error._tag === 'Rejected' && error.docsPage
              ? html`<a
                  href=${texraGuideUrl(error.docsPage)}
                  target="_blank"
                  rel="noopener noreferrer"
                  >${READ_GUIDE_BUTTON_LABEL}</a
                >`
              : nothing
          }
        </div>
        ${renderIconActionButton({
          id: 'dismiss-request-notice',
          icon: 'xmark',
          label: 'Dismiss message',
          tooltip: 'Dismiss message',
          onClick: () => {
            this.dispatchEvent(
              SessionUiEvents.surface({ kind: 'dismissRequestError' }),
            );
          },
        })}
      </div>
    </wa-callout>`;
  }

  private renderHeader(
    run: RunView | null,
    host: HostSnapshot,
    surface: Surface,
    view: SessionView,
  ): TemplateResult | typeof nothing {
    const embedded = this.placement === 'embedded';
    const sessions = renderIconActionButtonParts({
      id: 'shell-sessions',
      icon: 'list-ul',
      label: 'Tasks',
      tooltip: 'Tasks',
      className: 'sessions-button',
      slot: 'start',
      pressed: surface.drawerOpen,
      onClick: this.toggleDrawer,
    });
    const newTask = renderIconActionButtonParts({
      id: 'shell-new-task',
      icon: 'plus',
      label: 'New task',
      tooltip: 'New task',
      slot: 'end',
      onClick: this.selectNew,
    });
    const settings = renderIconActionButtonParts({
      id: 'shell-settings',
      icon: 'gear',
      label: 'Settings',
      tooltip: 'Settings',
      slot: 'end',
      onClick: () =>
        this.dispatchEvent(SessionUiEvents.host({ kind: 'openSettings' })),
    });
    // New task and Settings end the row unless the host's chrome has
    // them. Docked wide, a 300px + 1fr grid: the dock names the project.
    const start = embedded ? [] : [sessions];
    const end = embedded ? [] : [newTask, settings];
    return html`
      <header class="shell-header">
        <div class="header-dock">
          <span class="shell-title">${host.project.name}</span>
        </div>
        <div class="header-main">
          <slot name="header-start"></slot>
          ${
            run
              ? html`<run-header
                    class="header-run"
                    .run=${run}
                    .view=${view}
                    .menuItems=${this.windowItems()}
                    .plannedPasses=${documentRevisionsOf(run)}
                    >${start.map((b) => b.button)}${end.map((b) => b.button)}</run-header
                  >${start.map((b) => b.tooltip)}${end.map((b) => b.tooltip)}`
              : html`${start.map((b) => [b.button, b.tooltip])}
                  <span class="shell-title header-main-title">New task</span>
                  <span class="spacer"></span>
                  ${end.map((b) => [b.button, b.tooltip])}
                  ${this.renderOverflow()}`
          }
          <slot name="header-end"></slot>
        </div>
      </header>
    `;
  }

  /** The New-task state's menu: the window items alone. */
  private renderOverflow(): TemplateResult | typeof nothing {
    const items = this.windowItems();
    if (items.length === 0) return nothing;
    const menu = actionMenu(items);
    const more = renderIconActionButtonParts({
      id: 'shell-more',
      icon: 'ellipsis',
      slot: 'trigger',
      label: 'More',
      tooltip: 'More',
    });
    return html`
      <wa-dropdown placement="bottom-end" @wa-select=${menu.onSelect}>
        ${more.button} ${menu.items}
      </wa-dropdown>
      ${more.tooltip}
    `;
  }

  /** The wide editor tab's left column: the drawer body, docked. Its
   *  header is the shell header's dock cell; the drawer's filter sits
   *  above the list. */
  private renderDockedList(
    view: SessionView,
    surface: Surface,
  ): TemplateResult {
    return html`
      <aside class="dock" aria-label="Tasks">
        ${renderTaskFilter(this, surface.search)}
        <run-tabs sections .view=${view} .surface=${surface}></run-tabs>
      </aside>
    `;
  }

  /** The hero slot holds one card: setup while the funnel is
   *  pending, else the project starter while the folder has no LaTeX
   *  files, else the prompt. Without a credential the welcome card
   *  replaces the whole state (see below). */
  private renderHero(host: HostSnapshot): TemplateResult {
    if (host.onboarding === 'setup') {
      return html`<section class="hero" aria-labelledby="shell-hero-title">
        <div class="hero-mark" aria-hidden="true">${waIcon('rocket')}</div>
        <h1 id="shell-hero-title">Set up ${host.project.name}</h1>
        <p>${ONBOARDING_SETUP_HANDOFF}</p>
        <div class="hero-actions">
          ${renderLabeledActionButton({
            id: 'onboardingRunSetupButton',
            icon: 'rocket',
            text: 'Run setup assistant',
            kind: 'primary',
            onClick: () => this.onboarding('runSetup'),
          })}
          ${renderLabeledActionButton({
            id: 'onboardingSkipSetupButton',
            text: 'Skip setup',
            onClick: () => this.onboarding('skipSetup'),
          })}
        </div>
      </section>`;
    }
    if (host.banners.gettingStarted) {
      return html`<new-task-hero
          .projectName=${host.project.name}
        ></new-task-hero>
        <getting-started-banner></getting-started-banner>`;
    }
    return html`<new-task-hero
      .projectName=${host.project.name}
    ></new-task-hero>`;
  }

  /** The hero while the form is open on an agent's proposal: whose launch
   *  it is, and the way back to the run that asked. */
  private renderEditingHero(
    view: SessionView,
    surface: Surface,
  ): TemplateResult | null {
    const edited = editedProposal(surface, view);
    if (edited === null) return null;
    const { data, run } = edited;
    const asking = run?.label ?? 'An agent';
    const askingSubject =
      asking === 'assistant' ? 'The assistant' : Str.capitalize(asking);
    return html`<section class="hero" aria-labelledby="shell-hero-title">
      <div class="hero-mark" aria-hidden="true">${waIcon('pencil')}</div>
      <h1 id="shell-hero-title">Check ${data.label} before it runs</h1>
      <p>
        ${askingSubject} asked to run ${data.label}. Change what you need, then
        approve to start it with your changes.
      </p>
      <div class="hero-actions">
        ${renderLabeledActionButton({
          id: 'editingBackButton',
          icon: 'reply',
          text: `Back to ${asking}`,
          onClick: () =>
            this.dispatchEvent(
              SessionUiEvents.surface({ kind: 'select', runId: data.runId }),
            ),
        })}
      </div>
    </section>`;
  }

  private renderEmptyState(
    view: SessionView,
    surface: Surface,
    host: HostSnapshot,
  ): TemplateResult {
    if (host.onboarding === 'needs-credential') {
      // Without a credential the pickers and files are meaningless: the
      // welcome card replaces the whole New-task state.
      return html`
        <div class="empty">
          <onboarding-welcome-card></onboarding-welcome-card>
        </div>
      `;
    }
    const { launch } = surface;
    // Only a program reads Input and Context, and the form starts none
    // itself: the file section shows while the form is open on a program's
    // proposal. A chat attaches through the composer alone.
    const edited = editedProposal(surface, view);
    const documentPass = edited?.data.task === true;
    const selectedFiles = FILE_SELECT_CONFIGS.flatMap(
      (config) => launch[LAUNCH_FILE_LISTS[config.type]],
    );
    const { rollup } = view;
    // An embedded shell's host lists the running tasks itself.
    const activeNow =
      this.placement !== 'embedded' &&
      rollup.running + rollup.waiting + rollup.interrupted > 0;
    return html`
      <div class="empty">
        <div class="hero-wrap">
          ${this.renderEditingHero(view, surface) ?? this.renderHero(host)}
          ${
            documentPass
              ? html`<wa-details class="context" open>
                  <span slot="summary" class="context-summary"
                    >${waIcon('file-circle-plus')} Documents and attachments
                    <span class="context-files"
                      >${
                        selectedFiles.length === 0
                          ? 'Add files'
                          : selectedFiles.map(getBasename).join(', ')
                      }</span
                    ></span
                  >
                  <div class="context-body">
                    ${repeat(
                      FILE_SELECT_CONFIGS,
                      (config) => config.type,
                      (config) => html`
                        <file-select-group
                          .config=${config}
                          .files=${launch[LAUNCH_FILE_LISTS[config.type]]}
                        ></file-select-group>
                      `,
                    )}
                  </div>
                </wa-details>`
              : nothing
          }
        </div>
        ${
          activeNow
            ? html`<section class="active-now" aria-label="Active now">
                <div class="active-label">Active now</div>
                <run-tabs
                  activeOnly
                  topLevelOnly
                  .view=${view}
                  .surface=${surface}
                ></run-tabs>
              </section>`
            : nothing
        }
        <div class="launch-banners">
          <session-banners .banners=${host.banners}></session-banners>
        </div>
        <launch-attachments .files=${documentPass ? [] : launch.mediaFiles}
          ><session-composer
            class="launch-composer"
            .view=${view}
            .surface=${surface}
            .run=${null}
            .host=${host}
          ></session-composer
        ></launch-attachments>
      </div>
    `;
  }
}
