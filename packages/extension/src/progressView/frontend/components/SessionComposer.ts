/**
 * The composer, one component in two states (PRD 12.1). Expanded, it is the
 * new-task launcher: the instruction, chips for agent (teams as a section),
 * model, mode, and working directory (only with two or more roots), and the
 * polish, dictation, attach, and send controls. Compact, it is the follow-up
 * line with the same trailing controls, under a "Goes to X" line that offers
 * the parent instead.
 *
 * It reads `Surface` (the draft or the launch selections) and the `host`
 * snapshot (the catalogs) and dispatches the arm for every change: a
 * `SurfaceAction` for text and selections, a `HostRequest` for launch,
 * polish, dictation, pickers, and pasted images, a `RuntimeRequest` for a
 * follow-up. It holds no draft of its own.
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { live } from 'lit/directives/live.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

import type { SessionType, StreamTabId } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { EMPTY_DRAFT, type Draft, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { appendClipboardImageChips } from '@shared/utils/clipboard';
import {
  clipboardImageFiles,
  getExtensionFromMimeType,
  readFileAsBase64,
  type ExtractedClipboardImage,
} from '@shared/utils/clipboardImages';
import { getTextareaValue, insertTextAtCursor } from '@shared/utils/textarea';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { filterNotNullish } from '@utils/core';
import { generatePastedImageName } from '@utils/files/pastedImageName';
import './QueuedFollowUps';

const MODE_LABELS: Record<SessionType, string> = {
  toolUse: 'Interactive',
  workflow: 'Workflow',
};

interface ChipMenu {
  readonly id: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title: string;
  readonly items: TemplateResult;
  readonly onSelect: (value: string) => void;
}

function selectedValue(event: Event): string {
  const item = (event as CustomEvent<{ item?: { value?: unknown } }>).detail
    ?.item;
  return typeof item?.value === 'string' ? item.value : '';
}

@customElement('session-composer')
export class SessionComposer extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
        min-width: 0;
        container-type: inline-size;
      }

      .routing {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        min-width: 0;
      }
      .routing wa-icon {
        font-size: var(--font-size-xs);
        flex-shrink: 0;
      }
      .routing .routing-target {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .routing .routing-parent {
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        font: inherit;
        color: var(--color-text-link);
        cursor: pointer;
        white-space: nowrap;
      }
      .routing .routing-parent:hover {
        text-decoration: underline;
      }
      .routing .routing-note {
        white-space: nowrap;
        color: var(--color-text-muted);
      }

      .composer {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
        min-width: 0;
        padding: var(--wa-space-2xs);
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--wa-border-radius-l);
        background: var(--wa-color-surface-raised);
        transition: border-color var(--transition-fast);
      }
      .composer:focus-within {
        border-color: color-mix(
          in srgb,
          var(--wa-color-focus) 42%,
          var(--wa-color-surface-border)
        );
      }
      /* Compact: one pill, the follow-up line and its trailing controls on
         one row; the textarea grows with its content up to a few lines. */
      .composer.is-compact {
        flex-direction: row;
        align-items: flex-end;
        gap: var(--wa-space-3xs);
        padding: var(--wa-space-3xs) var(--wa-space-3xs) var(--wa-space-3xs)
          var(--wa-space-2xs);
        border-radius: var(--wa-border-radius-xl, 20px);
      }
      .composer.is-compact wa-textarea {
        flex: 1 1 auto;
        min-width: 0;
      }
      .composer.is-compact wa-textarea::part(base) {
        min-height: 0;
      }
      .composer.is-compact wa-textarea::part(textarea) {
        min-height: 1.5em;
        height: auto;
        padding-block: var(--wa-space-3xs);
      }
      .composer.is-compact .row {
        flex: 0 0 auto;
      }
      /* Collapsed, the pill is the field and one chevron; the tools and the
         send button appear once the field has focus or text. */
      .composer.is-compact .tools,
      .composer:not(.is-compact) .expand,
      .composer.is-compact:is(:focus-within, .has-text) .expand {
        display: none;
      }
      .composer.is-compact:is(:focus-within, .has-text) .tools,
      .composer.is-compact .expand {
        display: contents;
      }

      wa-textarea::part(base) {
        border: none;
        box-shadow: none;
        background: transparent;
      }
      wa-textarea::part(textarea) {
        padding-inline: var(--wa-space-3xs);
        font-family: var(--wa-font-family-body, inherit);
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
        field-sizing: content;
        min-height: 0;
        max-height: 10em;
      }

      .row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        min-width: 0;
      }
      .row .spacer {
        flex: 1 1 auto;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--wa-space-3xs);
        min-width: 0;
        flex: 1 1 auto;
      }
      .chip-trigger::part(base) {
        gap: var(--wa-space-3xs);
        padding-inline: var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        border-radius: var(--wa-border-radius-pill, 999px);
      }
      .chip-trigger wa-icon {
        font-size: var(--font-size-xs);
      }
      .chip-label {
        max-width: 14ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .menu-heading {
        padding: var(--wa-space-3xs) var(--wa-space-xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        text-transform: uppercase;
        letter-spacing: 0.02em;
        color: var(--color-text-muted);
      }
      .chips-collapsed {
        display: none;
      }
      @container (max-width: 380px) {
        .chips {
          display: none;
        }
        .chips-collapsed {
          display: block;
        }
      }

      .composer-primary-action::part(base) {
        border-radius: var(--wa-border-radius-circle, 50%);
      }
      .recording::part(base) {
        color: var(--wa-color-danger-on-quiet);
      }
      queued-follow-ups {
        display: block;
        min-width: 0;
        margin-bottom: var(--wa-space-2xs);
      }
    `,
  ];

  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  /** The stream a follow-up goes to; null is the expanded launch state. */
  @property({ attribute: false }) stream: StreamView | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;

  @state() private announcement = '';

  @query('wa-textarea') private textArea?: HTMLElement;

  private get compact(): boolean {
    return this.stream !== null;
  }

  private get draft(): Draft {
    const stream = this.stream;
    if (!stream) return EMPTY_DRAFT;
    return this.surface?.drafts.get(stream.id) ?? EMPTY_DRAFT;
  }

  private get text(): string {
    const launch = this.surface?.launch;
    if (this.compact) return this.draft.text;
    return launch ? launch.instruction[launch.sessionType] : '';
  }

  private get recordingTarget(): string {
    return this.stream?.id ?? 'launch';
  }

  private get recording(): boolean {
    const recording = this.host?.recording;
    return (
      recording !== null &&
      recording !== undefined &&
      recording.session === this.surface?.session &&
      recording.target === this.recordingTarget
    );
  }

  private setText(text: string, patch: Partial<Draft> = {}): void {
    const stream = this.stream;
    if (stream) {
      // A draft's images are the `[name]` chips its text still carries: a
      // chip the user deleted takes its image with it, so the send reads the
      // draft as it stands.
      const images = (patch.images ?? this.draft.images).filter((image) =>
        text.includes(`[${image.fileName}]`),
      );
      this.dispatchEvent(
        SessionUiEvents.surface({
          kind: 'draft',
          streamId: stream.id,
          patch: { text, images },
        }),
      );
      return;
    }
    const launch = this.surface?.launch;
    if (!launch) return;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'launch',
        patch: {
          instruction: { ...launch.instruction, [launch.sessionType]: text },
        },
      }),
    );
  }

  private handleInput = (event: Event): void => {
    this.setText(getTextareaValue(event.target as HTMLElement));
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    this.send();
  };

  private send = (): void => {
    const text = this.text.trim();
    const stream = this.stream;
    if (stream) {
      const draft = this.draft;
      if (text === '' && draft.images.length === 0) return;
      this.dispatchEvent(
        SessionUiEvents.runtime({
          kind: 'followUp.send',
          streamId: stream.id,
          text: text === '' ? '(image)' : text,
          mediaFiles:
            draft.images.length > 0
              ? draft.images.map((image) => image.fileName)
              : null,
        }),
      );
      return;
    }
    if (text === '' || !this.surface) return;
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'launch',
        launch: this.surface.launch,
        instruction: text,
      }),
    );
  };

  private polish = (): void => {
    const text = this.text.trim();
    if (text === '') return;
    this.dispatchEvent(SessionUiEvents.host({ kind: 'polish', text }));
  };

  private toggleRecording = (): void => {
    this.dispatchEvent(
      SessionUiEvents.host({
        kind: 'record',
        action: this.recording
          ? { kind: 'stop' }
          : { kind: 'start', target: this.recordingTarget },
      }),
    );
  };

  private attach = (): void => {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'pickFiles', fileType: 'media' }),
    );
  };

  private handlePaste = (event: ClipboardEvent): void => {
    const files = clipboardImageFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    const pastedText = event.clipboardData?.getData('text/plain') || '';
    const target = this.textArea;
    void Promise.all(
      files.map(
        async ({ file, type }): Promise<ExtractedClipboardImage | null> => {
          const base64 = await readFileAsBase64(file);
          if (!base64) return null;
          return {
            fileName: generatePastedImageName(getExtensionFromMimeType(type)),
            base64,
            mediaType: type,
          };
        },
      ),
    ).then((images) => {
      const added = images.filter(filterNotNullish);
      if (added.length === 0) return;
      for (const image of added) {
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'savePastedImage', ...image }),
        );
      }
      const insert = appendClipboardImageChips(
        pastedText,
        added.map(({ fileName }) => fileName),
      );
      if (target && this.isConnected) {
        insertTextAtCursor(target, insert);
        this.setText(getTextareaValue(target), {
          images: [...this.draft.images, ...added],
        });
      } else {
        this.setText(`${this.text}${insert}`, {
          images: [...this.draft.images, ...added],
        });
      }
      this.announcement =
        added.length === 1
          ? 'Image attached.'
          : `${added.length} images attached.`;
    });
  };

  private replyToParent(parentId: StreamTabId): void {
    const stream = this.stream;
    if (!stream) return;
    const draft = this.draft;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'draft',
        streamId: parentId,
        patch: draft,
      }),
    );
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'draft',
        streamId: stream.id,
        patch: EMPTY_DRAFT,
      }),
    );
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'select', streamId: parentId }),
    );
  }

  private setLaunch(patch: Partial<Surface['launch']>): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'launch', patch }));
  }

  private openSettings(
    section: 'agents' | 'teams' | 'models',
    sessionType?: SessionType,
  ): void {
    this.dispatchEvent(
      SessionUiEvents.host({ kind: 'openSettings', section, sessionType }),
    );
  }

  private chipMenus(): ChipMenu[] {
    const launch = this.surface?.launch;
    const host = this.host;
    if (!launch || !host) return [];
    const sessionType = launch.sessionType;
    const agents = host.agentOptions[sessionType] ?? [];
    const agentId = launch.agent[sessionType];
    const team = host.teamOptions.find(
      (option) => option.value === launch.selectedTeamId,
    );
    const agentLabel =
      launch.launchTarget === 'team' && team
        ? team.label
        : (agents.find((option) => option.value === agentId)?.label ?? agentId);
    const model = host.modelOptions.find(
      (option) => option.value === launch.model,
    );
    const menus: ChipMenu[] = [
      {
        id: 'composer-agent',
        icon: 'robot',
        label: agentLabel,
        title: 'Agent',
        items: html`
          ${repeat(
            agents,
            (option) => option.value,
            (option) =>
              html`<wa-dropdown-item
                value=${`agent:${option.value}`}
                type="checkbox"
                ?checked=${
                  launch.launchTarget === 'agent' && option.value === agentId
                }
                >${option.label}</wa-dropdown-item
              >`,
          )}
          ${
            sessionType === 'toolUse' && host.teamOptions.length > 0
              ? html`<div class="menu-heading">Teams</div>
                  ${repeat(
                    host.teamOptions,
                    (option) => option.value,
                    (option) =>
                      html`<wa-dropdown-item
                        value=${`team:${option.value}`}
                        type="checkbox"
                        ?checked=${
                          launch.launchTarget === 'team' &&
                          option.value === launch.selectedTeamId
                        }
                        >${option.label}</wa-dropdown-item
                      >`,
                  )}
                  <wa-dropdown-item value="settings:teams"
                    >Manage teams…</wa-dropdown-item
                  >`
              : nothing
          }
          <wa-dropdown-item value="settings:agents"
            >Agent settings…</wa-dropdown-item
          >
        `,
        onSelect: (value) => {
          if (value.startsWith('agent:')) {
            this.setLaunch({
              launchTarget: 'agent',
              agent: { ...launch.agent, [sessionType]: value.slice(6) },
            });
          } else if (value.startsWith('team:')) {
            this.setLaunch({
              launchTarget: 'team',
              selectedTeamId: value.slice(5),
            });
          } else if (value === 'settings:teams') {
            this.openSettings('teams');
          } else if (value === 'settings:agents') {
            this.openSettings('agents', sessionType);
          }
        },
      },
      {
        id: 'composer-model',
        icon: 'bolt',
        label: model?.label ?? launch.model,
        title: 'Model',
        items: html`
          ${repeat(
            host.modelOptions,
            (option) => option.value,
            (option) =>
              html`<wa-dropdown-item
                value=${`model:${option.value}`}
                type="checkbox"
                ?checked=${option.value === launch.model}
                ?disabled=${option.disabled === true}
                >${option.label}</wa-dropdown-item
              >`,
          )}
          <wa-dropdown-item value="settings:models"
            >Model settings…</wa-dropdown-item
          >
        `,
        onSelect: (value) => {
          if (value.startsWith('model:')) {
            this.setLaunch({ model: value.slice(6) });
          } else if (value === 'settings:models') {
            this.openSettings('models');
          }
        },
      },
      {
        id: 'composer-mode',
        icon: 'screwdriver-wrench',
        label: MODE_LABELS[sessionType],
        title: 'Mode',
        items: html`
          ${(Object.keys(MODE_LABELS) as SessionType[]).map(
            (mode) =>
              html`<wa-dropdown-item
                value=${`mode:${mode}`}
                type="checkbox"
                ?checked=${mode === sessionType}
                >${MODE_LABELS[mode]}</wa-dropdown-item
              >`,
          )}
        `,
        onSelect: (value) => {
          if (value.startsWith('mode:')) {
            this.setLaunch({ sessionType: value.slice(5) as SessionType });
          }
        },
      },
    ];
    if (host.workspaceRoots.length >= 2) {
      const root = host.workspaceRoots.find(
        (option) => option.value === launch.workingDirectory,
      );
      menus.push({
        id: 'composer-root',
        icon: 'folder-open',
        label: root?.label ?? host.workspaceRoots[0].label,
        title: 'Working directory',
        items: html`${repeat(
          host.workspaceRoots,
          (option) => option.value,
          (option) =>
            html`<wa-dropdown-item
              value=${`root:${option.value}`}
              type="checkbox"
              ?checked=${option.value === launch.workingDirectory}
              >${option.label}</wa-dropdown-item
            >`,
        )}`,
        onSelect: (value) => {
          if (value.startsWith('root:')) {
            this.setLaunch({ workingDirectory: value.slice(5) });
          }
        },
      });
    }
    return menus;
  }

  private renderChip(menu: ChipMenu): TemplateResult {
    return html`<wa-dropdown
        placement="top-start"
        @wa-select=${(event: Event) => menu.onSelect(selectedValue(event))}
      >
        <wa-button
          slot="trigger"
          id=${menu.id}
          class="chip-trigger"
          appearance="outlined"
          variant="neutral"
          size="s"
          type="button"
          with-caret
          >${waIcon(menu.icon, { slot: 'start' })}<span class="chip-label"
            >${menu.label}</span
          ></wa-button
        >
        ${menu.items}
      </wa-dropdown>
      <wa-tooltip for=${menu.id}>${menu.title}</wa-tooltip>`;
  }

  private renderChips(): TemplateResult {
    const menus = this.chipMenus();
    return html`
      <div class="chips">${menus.map((menu) => this.renderChip(menu))}</div>
      <div class="chips-collapsed">
        <wa-dropdown
          placement="top-start"
          @wa-select=${(event: Event) => {
            const value = selectedValue(event);
            for (const menu of menus) menu.onSelect(value);
          }}
        >
          <wa-button
            slot="trigger"
            id="composer-setup"
            class="chip-trigger"
            appearance="outlined"
            variant="neutral"
            size="s"
            type="button"
            with-caret
            >${waIcon('screwdriver-wrench', { slot: 'start' })}<span
              class="chip-label"
              >${menus.map((menu) => menu.label).join(' · ')}</span
            ></wa-button
          >
          ${menus.map(
            (menu) =>
              html`<div class="menu-heading">${menu.title}</div>
                ${menu.items}`,
          )}
        </wa-dropdown>
        <wa-tooltip for="composer-setup">Setup</wa-tooltip>
      </div>
    `;
  }

  private renderRouting(stream: StreamView): TemplateResult {
    const parent = stream.parentId
      ? this.view?.streams.get(stream.parentId)
      : undefined;
    // The link moves the draft to the parent, or the line states that the
    // parent takes no replies (a workflow-script run has no chat).
    const parentAcceptsFollowUps =
      parent !== undefined && parent.followUpSupport !== 'unsupported';
    return html`<div class="routing">
      ${waIcon('code-branch')}
      <span class="routing-target">Goes to ${stream.label}</span>
      ${
        parent === undefined
          ? nothing
          : html`<span aria-hidden="true">·</span>${
                parentAcceptsFollowUps
                  ? html`<button
                      type="button"
                      class="routing-parent"
                      @click=${() => this.replyToParent(parent.id)}
                    >
                      reply to ${parent.label} instead
                    </button>`
                  : html`<span class="routing-note"
                      >${parent.label} takes no replies</span
                    >`
              }`
      }
    </div>`;
  }

  override render(): TemplateResult | typeof nothing {
    const stream = this.stream;
    if (stream && stream.followUpSupport === 'unsupported') return nothing;
    const compact = this.compact;
    const readOnly = stream?.readOnly === true;
    const queued = stream
      ? (this.view?.queuedFollowUps.get(stream.id) ?? [])
      : [];
    const text = this.text;
    const canSend =
      !readOnly && (text.trim() !== '' || this.draft.images.length > 0);
    const sendLabel = compact ? 'Send follow-up' : 'Run';

    return html`
      ${stream ? this.renderRouting(stream) : nothing}
      ${
        queued.length > 0
          ? html`<queued-follow-ups .messages=${queued}></queued-follow-ups>`
          : nothing
      }
      <div
        class=${classMap({
          composer: true,
          'is-compact': compact,
          'has-text': text.trim() !== '' || this.draft.images.length > 0,
        })}
      >
        <wa-textarea
          name=${compact ? 'follow-up-message' : 'instruction'}
          placeholder=${compact ? 'Follow-up' : 'Describe the outcome you want…'}
          rows=${compact ? '1' : '3'}
          resize="auto"
          autocomplete="off"
          spellcheck="true"
          ?disabled=${readOnly}
          .value=${live(text)}
          @input=${this.handleInput}
          @keydown=${this.handleKeydown}
          @paste=${this.handlePaste}
        >
          <span slot="label" class="visually-hidden"
            >${compact ? 'Follow-up message' : 'Instruction'}</span
          >
          <span slot="hint" class="visually-hidden">
            Press Enter to send or Shift+Enter for a new line. Paste images to
            attach them.
          </span>
        </wa-textarea>
        <div class="row">
          ${compact ? html`<span class="spacer"></span>` : this.renderChips()}
          <span class="expand"
            >${renderIconActionButton({
              id: 'composer-expand',
              icon: 'chevron-up',
              label: 'Write a follow-up',
              tooltip: 'Write a follow-up',
              disabled: readOnly,
              onClick: () => this.textArea?.focus(),
            })}</span
          >
          <span class="tools"
            >${renderIconActionButton({
              id: 'composer-polish',
              icon: 'wand-magic-sparkles',
              label: 'Polish',
              tooltip: 'Polish with AI',
              busy: this.surface?.polishing.has(
                this.stream?.id ?? `launch:${this.surface.launch.sessionType}`,
              ),
              disabled: readOnly || text.trim() === '',
              onClick: this.polish,
            })}
            ${renderIconActionButton({
              id: 'composer-record',
              icon: this.recording ? 'circle-stop' : 'microphone',
              label: this.recording ? 'Stop recording' : 'Dictate',
              tooltip: this.recording ? 'Stop recording' : 'Dictate',
              className: this.recording ? 'recording' : '',
              disabled: readOnly,
              onClick: this.toggleRecording,
            })}
            ${renderIconActionButton({
              id: 'composer-attach',
              icon: 'file-circle-plus',
              label: 'Attach',
              tooltip: 'Attach media files',
              disabled: readOnly,
              onClick: this.attach,
            })}
            ${renderIconActionButton({
              id: 'composer-send',
              icon: 'arrow-up',
              label: sendLabel,
              tooltip: sendLabel,
              className: 'composer-primary-action',
              appearance: 'filled',
              variant: 'brand',
              size: compact ? 'm' : 'l',
              busy:
                this.stream !== null &&
                this.surface?.sending.has(this.stream.id),
              disabled:
                !canSend ||
                (this.stream !== null &&
                  (this.surface?.sending.has(this.stream.id) ?? false)),
              onClick: this.send,
            })}</span
          >
        </div>
      </div>
      <div class="visually-hidden" role="status">${this.announcement}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'session-composer': SessionComposer;
  }
}
