/**
 * `<progress-app>`: the one conversation shell of the extension (PRD 12.1).
 * It is the root, the only element that holds the three records, and it
 * renders exactly one of two states from `resolveSelected`: the New task
 * empty state (hero, the context disclosure, the Active now strip, the
 * expanded composer) or the selected stream's conversation. The Sessions
 * drawer, the docked list of the wide editor tab, the Tools sheet, and the
 * header overflow hang off the same element.
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
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared webview
import '@shared/wa/spinner';
import type {
  CheckboxChangeDetail,
  MultipleFilesActionDetail,
  MultipleFilesTypeActionDetail,
  RemoveFileDetail,
  ReorderFilesDetail,
} from '@shared/schemas';
import { designTokens } from '@shared/styles';
import { LAUNCH_FILE_LISTS } from '@shared/launcher/fileSelectConfigs';
import { installToolbarTooltips } from '@shared/litControllers/TooltipController';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { resolveSelected, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { registerTeXRAWebAwesomeIcons } from '@shared/wa/webAwesomeIcons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { getBasename } from '@utils/core';

// Local imports - progress view frontend
import { progressAppStyles } from './progressAppStyles';
import './components/StreamTabs';
import './components/StreamConversation';
import './components/SessionBanners';
import './components/SessionComposer';
import './components/SessionDrawer';
import './components/ToolsSheet';
import '@webview/frontend/components/FileSelectGroup';
import '@webview/frontend/components/OnboardingSetupCard';
import '@webview/frontend/components/OnboardingWelcomeCard';

registerTeXRAWebAwesomeIcons();

/** A file list's `type`, from the `Surface.launch` field it edits. */
const FILE_TYPE_BY_LIST = Object.fromEntries(
  Object.entries(LAUNCH_FILE_LISTS).map(([type, list]) => [list, type]),
) as Record<
  (typeof LAUNCH_FILE_LISTS)[keyof typeof LAUNCH_FILE_LISTS],
  keyof typeof LAUNCH_FILE_LISTS
>;

type OverflowItem =
  | 'popOut'
  | 'popBack'
  | 'openDashboard'
  | 'latexdiffs'
  | 'figures'
  | 'compileInputPdf'
  | 'attachTexCount'
  | 'pack'
  | 'clean';

function menuValue(event: Event): string {
  const item = (event as CustomEvent<{ item?: { value?: unknown } }>).detail
    ?.item;
  return typeof item?.value === 'string' ? item.value : '';
}

@customElement('progress-app')
export class ProgressApp extends LitElement {
  static override styles = [designTokens, progressAppStyles];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** Fixed by the document hosting this surface. */
  @property() placement: 'sidebar' | 'editor' | 'desktop' = 'sidebar';
  /** The host's clock, for elapsed readings (G4). */
  @property({ type: Number }) nowMs: number | null = null;

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

  private stopStream(stream: StreamView): void {
    this.dispatchEvent(
      SessionUiEvents.runtime({ kind: 'stream.stop', streamId: stream.id }),
    );
  }

  private handleOverflow(value: string, stream: StreamView | null): void {
    const item = value as OverflowItem;
    switch (item) {
      case 'popOut':
      case 'popBack':
      case 'openDashboard':
      case 'compileInputPdf':
        this.dispatchEvent(SessionUiEvents.host({ kind: item }));
        return;
      case 'figures':
        this.dispatchEvent(SessionUiEvents.host({ kind: 'extractFigures' }));
        return;
      case 'latexdiffs':
        this.dispatchEvent(
          SessionUiEvents.surface({ kind: 'toolsSheet', open: true }),
        );
        return;
      case 'attachTexCount': {
        const launch = this.surface?.launch;
        if (!launch) return;
        this.dispatchEvent(
          SessionUiEvents.surface({
            kind: 'launch',
            patch: { attachTeXCount: !launch.attachTeXCount },
          }),
        );
        return;
      }
      case 'pack':
      case 'clean':
        if (!stream) return;
        this.dispatchEvent(
          SessionUiEvents.host({ kind: item, streamId: stream.id }),
        );
        return;
    }
  }

  override render(): TemplateResult | typeof nothing {
    const { view, surface, host } = this;
    if (!view || !surface || !host) return nothing;
    const selected = resolveSelected(view, surface);
    const stream =
      selected === null ? null : (view.streams.get(selected) ?? null);
    const docked = this.placement === 'editor';

    return html`
      <div
        class=${classMap({
          shell: true,
          'is-editor': docked,
          'has-stream': stream !== null,
        })}
      >
        ${this.renderHeader(stream, host, surface)}
        <div class="shell-body">
          ${docked ? this.renderDockedList(view, surface) : nothing}
          <main class="reading">
            ${
              stream
                ? html`<stream-conversation
                    .stream=${stream}
                    .view=${view}
                    .surface=${surface}
                    .host=${host}
                    .nowMs=${this.nowMs}
                  ></stream-conversation>`
                : this.renderEmptyState(view, surface, host)
            }
          </main>
        </div>
        ${
          surface.drawerOpen
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

  private renderHeader(
    stream: StreamView | null,
    host: HostSnapshot,
    surface: Surface,
  ): TemplateResult {
    const canStop =
      stream !== null &&
      !stream.readOnly &&
      (stream.group === 'running' || stream.group === 'waiting');
    // One 38px row. Docked wide (the editor tab past 720px), the row is a
    // 300px + 1fr grid: the dock cell carries the paper name and New task,
    // the reading cell the stream's actions; the sidebar and the narrow tab
    // show the sessions button and the title in one cell.
    return html`
      <header class="shell-header">
        <div class="header-dock">
          <span class="shell-title">${host.paper.name}</span>
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
          ${renderIconActionButton({
            id: 'shell-sessions',
            icon: 'list-ul',
            label: 'Sessions',
            tooltip: 'Sessions',
            className: 'sessions-button',
            pressed: surface.drawerOpen,
            onClick: this.toggleDrawer,
          })}
          <span class="shell-title header-main-title"
            >${stream ? host.paper.name : 'New task'}</span
          >
          <span class="spacer"></span>
          ${
            canStop
              ? renderIconActionButton({
                  id: 'shell-stop',
                  icon: 'circle-stop',
                  label: 'Stop',
                  tooltip: 'Stop',
                  className: 'stop-button',
                  onClick: () => this.stopStream(stream),
                })
              : nothing
          }
          ${renderIconActionButton({
            id: 'shell-new-task',
            icon: 'plus',
            label: 'New task',
            tooltip: 'New task',
            onClick: this.selectNew,
          })}
          ${this.renderOverflow(stream, host)}
        </div>
      </header>
    `;
  }

  /** The overflow in both states, so Open dashboard and the Tools sheet
   *  have one home reachable from the New-task state; the debug section
   *  needs a stream's output. */
  private renderOverflow(
    stream: StreamView | null,
    host: HostSnapshot,
  ): TemplateResult {
    const inEditor = this.placement === 'editor';
    const attachTexCount = this.surface?.launch.attachTeXCount === true;
    return html`
      <wa-dropdown
        placement="bottom-end"
        @wa-select=${(event: Event) =>
          this.handleOverflow(menuValue(event), stream)}
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
        <wa-dropdown-item value=${inEditor ? 'popBack' : 'popOut'}
          >${waIcon(inEditor ? 'backward-step' : 'picture-in-picture', {
            slot: 'icon',
          })}${inEditor ? 'Back to sidebar' : 'Open sessions in editor'}</wa-dropdown-item
        >
        <wa-dropdown-item value="openDashboard"
          >${waIcon('gear', { slot: 'icon' })}Open dashboard</wa-dropdown-item
        >
        <wa-divider></wa-divider>
        <wa-dropdown-item value="latexdiffs"
          >${waIcon('code-compare', { slot: 'icon' })}LaTeXDiffs…</wa-dropdown-item
        >
        <wa-dropdown-item value="figures"
          >${waIcon('image', { slot: 'icon' })}Figures…</wa-dropdown-item
        >
        <wa-dropdown-item value="compileInputPdf"
          >${waIcon('file-pdf', { slot: 'icon' })}Compile input
          PDF</wa-dropdown-item
        >
        <wa-dropdown-item
          value="attachTexCount"
          type="checkbox"
          ?checked=${attachTexCount}
          >${waIcon('list-check', { slot: 'icon' })}Attach TeX
          Count</wa-dropdown-item
        >
        ${
          host.debugMode && stream
            ? html`<wa-divider></wa-divider>
                <wa-dropdown-item value="pack"
                  >${waIcon('box-archive', { slot: 'icon' })}Pack output to
                  History</wa-dropdown-item
                >
                <wa-dropdown-item value="clean"
                  >${waIcon('trash', { slot: 'icon' })}Delete output
                  files</wa-dropdown-item
                >`
            : nothing
        }
      </wa-dropdown>
      <wa-tooltip for="shell-more">More</wa-tooltip>
    `;
  }

  private patchLaunch(patch: Partial<Surface['launch']>): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'launch', patch }));
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
        <stream-tabs sections .view=${view} .surface=${surface}></stream-tabs>
      </aside>
    `;
  }

  /** The hero, or the setup card in its place while the funnel is pending
   *  (PRD 12.1); each card action leaves as the `onboarding` host arm. */
  private renderHero(host: HostSnapshot): TemplateResult {
    if (host.onboarding === 'setup') {
      const onboarding = (
        action: 'runSetup' | 'openGettingStarted' | 'skipSetup',
      ) =>
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'onboarding', action }),
        );
      return html`<onboarding-setup-card
        @onboarding-run-setup=${() => onboarding('runSetup')}
        @onboarding-open-getting-started=${() =>
          onboarding('openGettingStarted')}
        @onboarding-skip-setup=${() => onboarding('skipSetup')}
      ></onboarding-setup-card>`;
    }
    return html`<section class="hero" aria-labelledby="shell-hero-title">
      <div class="hero-mark" aria-hidden="true">
        ${waIcon('wand-magic-sparkles')}
      </div>
      <h1 id="shell-hero-title">What are you working on?</h1>
      <p>
        ${host.paper.name}. Describe the outcome you want: a polish, a review, a
        literature pass, a proof check.
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
      const onboarding = (
        action: Extract<
          Parameters<typeof SessionUiEvents.host>[0],
          { kind: 'onboarding' }
        >['action'],
      ) =>
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'onboarding', action }),
        );
      return html`
        <div class="empty">
          <onboarding-welcome-card
            @welcome-chatgpt=${() => onboarding('signInChatGpt')}
            @welcome-api-key=${() => onboarding('setApiKey')}
            @welcome-skip=${() => onboarding('skip')}
            @onboarding-open-getting-started=${() =>
              onboarding('openGettingStarted')}
          ></onboarding-welcome-card>
        </div>
      `;
    }
    const { launch } = surface;
    const selectedFiles = host.fileConfigs.flatMap(
      (config) => launch[LAUNCH_FILE_LISTS[config.type]],
    );
    const { rollup } = view;
    const activeNow = rollup.running + rollup.waiting + rollup.interrupted > 0;
    return html`
      <div class="empty">
        <div class="hero-wrap">
          ${this.renderHero(host)}
          <wa-details class="context">
            <span slot="summary" class="context-summary"
              >${waIcon('file-circle-plus')} Context and attachments
              <span class="context-files"
                >${
                  selectedFiles.length === 0
                    ? 'Add files'
                    : selectedFiles.map(getBasename).join(', ')
                }</span
              ></span
            >
            <div
              class="context-body"
              @add-opened-files=${({
                detail,
              }: CustomEvent<MultipleFilesTypeActionDetail>) => {
                if (detail.type === 'output') return;
                this.dispatchEvent(
                  SessionUiEvents.host({
                    kind: 'addOpenedFiles',
                    fileType: detail.type,
                  }),
                );
              }}
              @select-multiple-files=${({
                detail,
              }: CustomEvent<MultipleFilesActionDetail>) => {
                const fileType = FILE_TYPE_BY_LIST[detail.listId];
                if (fileType === 'output') return;
                this.dispatchEvent(
                  SessionUiEvents.host({ kind: 'pickFiles', fileType }),
                );
              }}
              @empty-files=${({
                detail,
              }: CustomEvent<MultipleFilesTypeActionDetail>) =>
                this.patchLaunch({ [LAUNCH_FILE_LISTS[detail.type]]: [] })}
              @remove-file=${({ detail }: CustomEvent<RemoveFileDetail>) =>
                this.patchLaunch({
                  [detail.listId]: launch[detail.listId].filter(
                    (file) => file !== detail.file,
                  ),
                })}
              @files-reordered=${({
                detail,
              }: CustomEvent<ReorderFilesDetail>) =>
                this.patchLaunch({ [detail.listId]: detail.files })}
              @checkbox-change=${({
                detail,
              }: CustomEvent<CheckboxChangeDetail>) =>
                this.patchLaunch({ [detail.id]: detail.checked })}
            >
              ${repeat(
                host.fileConfigs,
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
                <stream-tabs
                  activeOnly
                  .view=${view}
                  .surface=${surface}
                ></stream-tabs>
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
          .stream=${null}
          .host=${host}
        ></session-composer>
      </div>
    `;
  }
}
