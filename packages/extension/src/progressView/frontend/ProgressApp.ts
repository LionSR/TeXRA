/**
 * `<progress-app>`: the one conversation shell of the extension (PRD 12.1).
 * It is the root, the only element that holds the three records, and it
 * renders exactly one of two states from `resolveSelected`: the New task
 * empty state (hero, the context disclosure, the Active now strip, the
 * expanded composer) or the selected run's conversation, under one header
 * row: the run's own header when a run is selected. The Sessions drawer,
 * the docked list of the wide editor tab, and the Tools sheet hang off the
 * same element. The desktop draws its own shell (rail, header) around this
 * element, so there it renders no Sessions button, New task, or drawer.
 *
 * `view`, `surface`, and `host` are properties: the design harness assigns
 * fixtures to them, and the live host assigns its signals to the same
 * names. Every send leaves as a `runtime-request`, `host-request`, or
 * `surface-action` event with the arm as its detail; the root's owner
 * installs one listener per event.
 */

// Third-party imports
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared webview
import '@ui/wa/spinner';
import {
  FILE_SELECT_CONFIGS,
  LAUNCH_FILE_LISTS,
} from '@shared/launcher/fileSelectConfigs';
import { installToolbarTooltips } from '@shared/litControllers/TooltipController';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { resolveSelected, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens } from '@ui/styles';
import {
  renderIconActionButton,
  renderIconActionButtonParts,
} from '@ui/wa/actionButtons';
import { registerTeXRAWebAwesomeIcons } from '@ui/wa/webAwesomeIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { ONBOARDING_SETUP_HANDOFF } from '@ui/copy/onboarding';
import { getBasename } from '@utils/core';

// Local imports - progress view frontend
import { progressAppStyles } from './progressAppStyles';
import './components/RunTabs';
import './components/RunConversation';
import './components/SessionBanners';
import './components/SessionComposer';
import './components/SessionDrawer';
import './components/ToolsSheet';
import './components/FileSelectGroup';
import './components/GettingStartedBanner';
import './components/OnboardingWelcomeCard';
import './components/RunHeader';
import type { HeaderMenuItem } from './components/RunHeader';

registerTeXRAWebAwesomeIcons();

@customElement('progress-app')
export class ProgressApp extends LitElement {
  static override styles = [designTokens, progressAppStyles];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** Fixed by the document hosting this surface. */
  @property() placement: 'sidebar' | 'editor' | 'desktop' = 'sidebar';

  override connectedCallback(): void {
    super.connectedCallback();
    installToolbarTooltips();
  }

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
   *  sheet, figure extraction. The New-task header shows them in its menu;
   *  a run's header appends them to the run's. The desktop has neither an
   *  editor to pop out into nor a figure extractor, and its LaTeXDiffs
   *  chip sits under the composer, so it is given none. */
  private windowItems(): HeaderMenuItem[] {
    if (this.placement === 'desktop') return [];
    const inEditor = this.placement === 'editor';
    const host = (kind: 'popOut' | 'popBack' | 'extractFigures') => () =>
      this.dispatchEvent(SessionUiEvents.host({ kind }));
    return [
      inEditor
        ? {
            value: 'popBack',
            icon: 'backward-step',
            label: 'Back to sidebar',
            activate: host('popBack'),
          }
        : {
            value: 'popOut',
            icon: 'picture-in-picture',
            label: 'Open sessions in editor',
            activate: host('popOut'),
          },
      {
        value: 'latexdiffs',
        icon: 'code-compare',
        label: 'LaTeXDiffs…',
        activate: () =>
          this.dispatchEvent(
            SessionUiEvents.surface({ kind: 'toolsSheet', open: true }),
          ),
      },
      {
        value: 'figures',
        icon: 'image',
        label: 'Figures…',
        activate: host('extractFigures'),
      },
    ];
  }

  override render(): TemplateResult | typeof nothing {
    const { view, surface, host } = this;
    if (!view || !surface || !host) return nothing;
    const selected = resolveSelected(view, surface);
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
          surface.drawerOpen && this.placement !== 'desktop'
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
    let message: string;
    switch (error._tag) {
      case 'Rejected':
      case 'Unavailable':
      case 'Invalid':
        message = error.reason;
        break;
      case 'NotOwner':
        message = 'This run is controlled by another TeXRA window.';
        break;
      case 'Internal':
        message = 'The request failed. See the TeXRA log for details.';
        break;
    }
    return html`<wa-callout class="request-notice" variant="danger">
      ${waIcon('circle-exclamation', { slot: 'icon' })}
      <div class="request-notice-content">
        <div>
          ${message}
          ${
            error._tag === 'Rejected' && error.docsCommand
              ? html`<a
                  href=${`https://texra.ai/guide/${error.docsCommand}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  >Read the file management guide</a
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
    const onDesktop = this.placement === 'desktop';
    // The desktop shell has its own header over this column; a run keeps
    // only its own row there, and the New-task state none.
    if (onDesktop && !run) return nothing;
    const sessions = renderIconActionButtonParts({
      id: 'shell-sessions',
      icon: 'list-ul',
      label: 'Sessions',
      tooltip: 'Sessions',
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
    // One 38px row. Docked wide (the editor tab past 720px), the row is a
    // 300px + 1fr grid: the dock cell carries the project name and New task,
    // the reading cell the run's header; the sidebar and the narrow tab
    // show the sessions button and the title in one cell.
    return html`
      <header class="shell-header">
        <div class="header-dock">
          <span class="shell-title">${host.project.name}</span>
          <span class="spacer"></span>
          ${renderIconActionButton({
            id: 'dock-new-task',
            icon: 'plus',
            label: 'New task',
            tooltip: 'New task',
            onClick: this.selectNew,
          })}
        </div>
        <div class="header-main">
          ${
            run
              ? html`<run-header
                    class="header-run"
                    .run=${run}
                    .view=${view}
                    .menuItems=${this.windowItems()}
                    >${onDesktop ? nothing : [sessions.button, newTask.button]}</run-header
                  >${onDesktop ? nothing : [sessions.tooltip, newTask.tooltip]}`
              : html`${sessions.button}${sessions.tooltip}
                  <span class="shell-title header-main-title">New task</span>
                  <span class="spacer"></span>
                  ${newTask.button}${newTask.tooltip} ${this.renderOverflow()}`
          }
        </div>
      </header>
    `;
  }

  /** The New-task state's menu: the window items alone. */
  private renderOverflow(): TemplateResult {
    const items = this.windowItems();
    return html`
      <wa-dropdown
        placement="bottom-end"
        @wa-select=${(event: Event) => {
          const value = (event as CustomEvent<{ item?: { value?: unknown } }>)
            .detail?.item?.value;
          items.find((item) => item.value === value)?.activate();
        }}
      >
        <wa-button
          slot="trigger"
          id="shell-more"
          class="action-icon-button"
          appearance="plain"
          variant="neutral"
          size="s"
          type="button"
          aria-label="More"
          >${waIcon('ellipsis')}</wa-button
        >
        ${repeat(
          items,
          (item) => item.value,
          (item) =>
            html`<wa-dropdown-item value=${item.value}
              >${waIcon(item.icon, { slot: 'icon' })}${item.label}</wa-dropdown-item
            >`,
        )}
      </wa-dropdown>
      <wa-tooltip for="shell-more">More</wa-tooltip>
    `;
  }

  private handleSearchInput = (event: Event): void => {
    const value = (event.target as HTMLInputElement).value;
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'search', value }));
  };

  /** The wide editor tab's left column: the drawer body, docked. Its
   *  header is the shell header's dock cell; the filter sits above the
   *  list, bound to `Surface.search` like the drawer's. */
  private renderDockedList(
    view: SessionView,
    surface: Surface,
  ): TemplateResult {
    return html`
      <aside class="dock" aria-label="Sessions">
        <div class="dock-search">
          <wa-input
            size="s"
            placeholder="Filter sessions"
            .value=${live(surface.search)}
            @input=${this.handleSearchInput}
          >
            ${waIcon('magnifying-glass', { slot: 'start' })}
          </wa-input>
        </div>
        <run-tabs sections .view=${view} .surface=${surface}></run-tabs>
      </aside>
    `;
  }

  /** The hero slot holds one card (PRD 12.1): setup while the funnel is
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
          <wa-button
            id="onboardingRunSetupButton"
            variant="brand"
            size="s"
            @click=${() => this.onboarding('runSetup')}
            >${waIcon('rocket', { slot: 'start' })}Run setup
            assistant</wa-button
          >
          <wa-button
            id="onboardingSkipSetupButton"
            appearance="plain"
            size="s"
            @click=${() => this.onboarding('skipSetup')}
            >Skip setup</wa-button
          >
        </div>
      </section>`;
    }
    if (host.banners.gettingStarted) {
      return html`<getting-started-banner></getting-started-banner>`;
    }
    return html`<section class="hero" aria-labelledby="shell-hero-title">
      <div class="hero-mark" aria-hidden="true">
        ${waIcon('wand-magic-sparkles')}
      </div>
      <h1 id="shell-hero-title">What are you working on?</h1>
      <p>
        ${host.project.name}. Describe the outcome you want: a polish, a review,
        a literature pass, a proof check.
      </p>
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
    // Only a document pass reads Input and Context; an interactive agent
    // gets the instruction and its attachments, so it shows only those.
    const documentPass = launch.sessionType === 'workflow';
    const fileGroups = documentPass
      ? FILE_SELECT_CONFIGS
      : FILE_SELECT_CONFIGS.filter((config) => config.type === 'media');
    const selectedFiles = fileGroups.flatMap(
      (config) => launch[LAUNCH_FILE_LISTS[config.type]],
    );
    const { rollup } = view;
    const activeNow = rollup.running + rollup.waiting + rollup.interrupted > 0;
    return html`
      <div class="empty">
        <div class="hero-wrap">
          ${this.renderHero(host)}
          <!-- A document pass cannot run without an input file, so picking
            one opens the file groups. -->
          <wa-details class="context" ?open=${documentPass}>
            <span slot="summary" class="context-summary"
              >${waIcon('file-circle-plus')}
              ${documentPass ? 'Documents and attachments' : 'Attachments'}
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
                fileGroups,
                (config) => config.type,
                (config) => html`
                  <file-select-group
                    .config=${config}
                    .files=${launch[LAUNCH_FILE_LISTS[config.type]]}
                    .checkboxValues=${launch}
                    .sessionType=${launch.sessionType}
                  ></file-select-group>
                `,
              )}
            </div>
          </wa-details>
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
        <session-banners
          class="launch-banners"
          .banners=${host.banners}
          .sessionType=${launch.sessionType}
        ></session-banners>
        <session-composer
          class="launch-composer"
          .view=${view}
          .surface=${surface}
          .run=${null}
          .host=${host}
        ></session-composer>
      </div>
    `;
  }
}
