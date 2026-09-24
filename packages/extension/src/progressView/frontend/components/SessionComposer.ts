/**
 * The composer, one component in two states (PRD 12.1). Expanded, it is the
 * new-task launcher: the instruction, chips for agent and model (and the
 * working directory, only with two or more roots), and the polish,
 * dictation, attach, and send controls. The agent menu lists interactive
 * agents, document passes and teams as sections: the agent picked is the
 * run type. Compact, it is the follow-up line with the same trailing
 * controls, under a line that offers the parent instead when there is one.
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
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

import {
  isModelOptionAvailable,
  type SessionType,
  type RunId,
} from '@shared/schemas';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, RunView } from '@shared/session/sessionView';
import {
  canSendFollowUp,
  EMPTY_DRAFT,
  type Draft,
  type Surface,
} from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { appendClipboardImageChips } from '@shared/utils/clipboard';
import {
  clipboardImageFiles,
  getExtensionFromMimeType,
  readFileAsBase64,
  type ExtractedClipboardImage,
} from '@shared/utils/clipboardImages';
import { designTokens, commonViewStyles } from '@ui/styles';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { filterNotNullish } from '@utils/core';
import { generatePastedImageName } from '@utils/files/pastedImageName';
import './QueuedFollowUps';

/** The agent menu's sections: the category an agent belongs to is the run
 *  type its launch takes. */
const AGENT_SECTIONS: ReadonlyArray<readonly [SessionType, string]> = [
  ['toolUse', 'Interactive'],
  ['workflow', 'Document passes'],
];

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
      .composer.is-compact textarea {
        flex: 1 1 auto;
        --textarea-min-height: calc(1lh + 2 * var(--wa-space-3xs));
        --textarea-max-height: 10em;
      }
      .composer.is-compact .row {
        flex: 0 0 auto;
      }
      /* Collapsed, the pill is the field alone; the tools and the send
         button appear once the field has focus or text. */
      .composer.is-compact .tools {
        display: none;
      }
      .composer.is-compact:is(:focus-within, .has-text) .tools {
        display: contents;
      }

      /* A plain native textarea (#11851): the card draws the one focus
         ring, so the field carries no chrome of its own and grows with its
         content between the two heights each state sets. */
      textarea {
        display: block;
        width: 100%;
        min-width: 0;
        margin: 0;
        border: 0;
        outline: none;
        background: transparent;
        color: inherit;
        resize: none;
        box-sizing: border-box;
        field-sizing: content;
        height: auto;
        min-height: var(--textarea-min-height);
        max-height: var(--textarea-max-height);
        padding: var(--wa-space-3xs);
        overflow-x: hidden;
        overflow-y: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: var(--wa-font-family-body, inherit);
        font-size: var(--font-size);
        line-height: var(--line-height-normal);
      }
      textarea::placeholder {
        color: var(--wa-color-text-quiet);
      }
      .composer:not(.is-compact) textarea {
        --textarea-min-height: calc(3lh + 2 * var(--wa-space-3xs));
        --textarea-max-height: clamp(var(--textarea-min-height), 32vh, 240px);
      }

      .row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        min-width: 0;
      }
      .tools {
        display: flex;
        align-items: center;
        flex: 0 0 auto;
        gap: var(--wa-space-3xs);
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
      .chip-trigger {
        max-width: 100%;
      }
      .chip-trigger::part(label) {
        min-width: 0;
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
        display: block;
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
  /** The run a follow-up goes to; null is the expanded launch state. */
  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;

  @state() private announcement = '';

  @query('textarea') private textArea?: HTMLTextAreaElement;

  private get compact(): boolean {
    return this.run !== null;
  }

  private get draft(): Draft {
    const run = this.run;
    if (!run) return EMPTY_DRAFT;
    return this.surface?.drafts.get(run.id) ?? EMPTY_DRAFT;
  }

  private get text(): string {
    const launch = this.surface?.launch;
    if (this.compact) return this.draft.text;
    return launch?.instruction ?? '';
  }

  private get recordingTarget(): RunId | 'launch' {
    return this.run?.id ?? 'launch';
  }

  private get recording(): boolean {
    const recording = this.host?.recording;
    return (
      recording != null &&
      recording.session === this.surface?.session &&
      recording.target === this.recordingTarget
    );
  }

  private setText(text: string, patch: Partial<Draft> = {}): void {
    const run = this.run;
    if (run) {
      // A draft's images are the `[name]` chips its text still carries: a
      // chip the user deleted takes its image with it, so the send reads the
      // draft as it stands.
      const images = (patch.images ?? this.draft.images).filter((image) =>
        text.includes(`[${image.fileName}]`),
      );
      this.dispatchEvent(
        SessionUiEvents.surface({
          kind: 'draft',
          runId: run.id,
          patch: { text, images },
        }),
      );
      return;
    }
    this.setLaunch({ instruction: text });
  }

  private handleInput = (event: Event): void => {
    this.setText((event.target as HTMLTextAreaElement).value);
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    this.send();
  };

  /** Send is the root's decision (`SessionSurfaces.submit`): the same one
   *  the run accelerator reaches, so the two cannot diverge. */
  private send = (): void => {
    this.dispatchEvent(SessionUiEvents.submit());
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
      // The draft holds each chip's name now and its stored path once the
      // host answers (`sessionSurfaces.settleHost`).
      const pending = added.map(({ fileName }) => ({ fileName, path: null }));
      if (target && this.isConnected) {
        // setRangeText fires no input event, so the draft is set explicitly.
        target.setRangeText(
          insert,
          target.selectionStart,
          target.selectionEnd,
          'end',
        );
        this.setText(target.value, {
          images: [...this.draft.images, ...pending],
        });
      } else {
        this.setText(`${this.text}${insert}`, {
          images: [...this.draft.images, ...pending],
        });
      }
      this.announcement =
        added.length === 1
          ? 'Image attached.'
          : `${added.length} images attached.`;
    });
  };

  private replyToParent(parentId: RunId): void {
    const run = this.run;
    if (!run) return;
    const draft = this.draft;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'draft',
        runId: parentId,
        patch: draft,
      }),
    );
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'draft',
        runId: run.id,
        patch: EMPTY_DRAFT,
      }),
    );
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'select', runId: parentId }),
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
    const team = host.teamOptions.find(
      (option) => option.value === launch.selectedTeamId,
    );
    const agentLabel =
      launch.launchTarget === 'team' && team
        ? team.label
        : (host.agentOptions[launch.sessionType]?.find(
            (option) => option.value === launch.agent,
          )?.label ?? launch.agent);
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
          ${AGENT_SECTIONS.map(([category, heading]) => {
            const agents = host.agentOptions[category] ?? [];
            if (agents.length === 0) return nothing;
            return html`<div class="menu-heading">${heading}</div>
              ${repeat(
                agents,
                (option) => option.value,
                (option) =>
                  html`<wa-dropdown-item
                    value=${`agent:${category}:${option.value}`}
                    type="checkbox"
                    ?checked=${
                      launch.launchTarget === 'agent' &&
                      launch.sessionType === category &&
                      option.value === launch.agent
                    }
                    >${option.label}</wa-dropdown-item
                  >`,
              )}`;
          })}
          ${
            host.teamOptions.length > 0
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
            >Browse all agents…</wa-dropdown-item
          >
        `,
        onSelect: (value) => {
          const agent = /^agent:(toolUse|workflow):(.+)$/.exec(value);
          if (agent) {
            this.setLaunch({
              sessionType: agent[1] as SessionType,
              agent: agent[2],
            });
          } else if (value.startsWith('team:')) {
            // A team runs its lead as an interactive session.
            this.setLaunch({
              launchTarget: 'team',
              sessionType: 'toolUse',
              selectedTeamId: value.slice(5),
            });
          } else if (value === 'settings:teams') {
            this.openSettings('teams');
          } else if (value === 'settings:agents') {
            this.openSettings('agents', launch.sessionType);
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
                ?disabled=${!isModelOptionAvailable(option)}
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
    return html`<div class="chips">
      ${this.chipMenus().map((menu) => this.renderChip(menu))}
    </div>`;
  }

  /** Where a follow-up goes, shown only when there is a parent to
   *  redirect it to: a top-level run's name is already in the header. */
  private renderRouting(run: RunView): TemplateResult | typeof nothing {
    const parent = run.parentId ? this.view?.runs.get(run.parentId) : undefined;
    if (parent === undefined) return nothing;
    // The link moves the draft to the parent, or the line states that the
    // parent takes no replies (a workflow-script run has no chat).
    return html`<div class="routing">
      ${waIcon('code-branch')}
      <span class="routing-target">Goes to ${run.label}</span>
      <span aria-hidden="true">·</span>${
        parent.followUpSupport !== 'unsupported'
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
      }
    </div>`;
  }

  override render(): TemplateResult | typeof nothing {
    const run = this.run;
    if (run && run.followUpSupport === 'unsupported') return nothing;
    const compact = this.compact;
    const readOnly = run?.readOnly === true;
    const queued = (
      run ? (this.view?.queuedFollowUps.get(run.id) ?? []) : []
    ).map((followUp) => followUp.text);
    const text = this.text;
    const hasText = text.trim() !== '';
    // A follow-up's Send and the Cmd+Alt+E accelerator read one rule
    // (`canSendFollowUp`); the launcher has no run and no draft images,
    // so its own Run turns on the instruction alone.
    const canSend = run ? canSendFollowUp(run, this.draft) : hasText;
    const sendLabel = compact ? 'Send follow-up' : 'Run';

    return html`
      ${run ? this.renderRouting(run) : nothing}
      ${
        queued.length > 0
          ? html`<queued-follow-ups .messages=${queued}></queued-follow-ups>`
          : nothing
      }
      <div
        class=${classMap({
          composer: true,
          'is-compact': compact,
          'has-text': hasText || this.draft.images.length > 0,
        })}
      >
        <label for="composer-text" class="visually-hidden"
          >${compact ? 'Follow-up message' : 'Instruction'}</label
        >
        <textarea
          id="composer-text"
          name=${compact ? 'follow-up-message' : 'instruction'}
          placeholder=${compact ? 'Follow-up' : 'Describe the outcome you want…'}
          rows=${compact ? '1' : '3'}
          autocomplete="off"
          spellcheck="true"
          aria-describedby="composer-text-hint"
          ?disabled=${readOnly}
          .value=${live(text)}
          @input=${this.handleInput}
          @keydown=${this.handleKeydown}
          @paste=${this.handlePaste}
        ></textarea>
        <div id="composer-text-hint" class="visually-hidden">
          Press Enter to send or Shift+Enter for a new line. Paste images to
          attach them.
        </div>
        <div class="row">
          ${compact ? html`<span class="spacer"></span>` : this.renderChips()}
          <span class="tools"
            >${renderIconActionButton({
              id: 'composer-polish',
              icon: 'wand-magic-sparkles',
              label: 'Polish',
              tooltip: 'Polish with AI',
              busy: this.surface?.polishing.has(this.run?.id ?? 'launch'),
              disabled: readOnly || !hasText,
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
            ${
              // The picker fills the launcher's media list; a follow-up
              // attaches by pasting, which the host stores for it.
              compact
                ? nothing
                : renderIconActionButton({
                    id: 'composer-attach',
                    icon: 'file-circle-plus',
                    label: 'Attach',
                    tooltip: 'Attach media files',
                    disabled: readOnly,
                    onClick: this.attach,
                  })
            }
            ${renderIconActionButton({
              id: 'composer-send',
              icon: 'arrow-up',
              label: sendLabel,
              tooltip: sendLabel,
              className: 'composer-primary-action',
              appearance: 'filled',
              variant: 'brand',
              size: compact ? 'm' : 'l',
              busy: this.run !== null && this.surface?.sending.has(this.run.id),
              disabled:
                !canSend ||
                (this.run !== null &&
                  (this.surface?.sending.has(this.run.id) ?? false)),
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
