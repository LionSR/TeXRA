/**
 * `<script-stage>`: the calls one `script` call issued, painted from the
 * shared script-stage model (`scriptStages` in `@texra-ai/harness/transcript`): the card's
 * summary line, then each section's calls as plain rows in issue order. An
 * `agent` row opens its child run; Review opens the run that is asking;
 * "Stop this agent", in a running row's menu, stops the call's child, which
 * the call then answers as `Skipped`. "Log" opens the calls' own cards
 * below the card. Holds no state: every send is a surface or runtime event.
 */

// Third-party imports
import { joinFacts } from '@texra-ai/harness/schemas';
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared contracts
import type { Surface } from '@texra/shared/session/surface';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { TALK_TO_AGENT } from '@ui/copy/nestedRuns';
import { requestErrorText } from '@ui/copy/requestErrors';
import { statusGlyph, type StatusLook } from '@ui/copy/runStatus';
import {
  SCRIPT_CALL_STATUS_LABEL,
  SCRIPT_CALL_STATUS_LOOK,
  scriptCallSummary,
  scriptStageSummary,
} from '@ui/copy/scriptStage';
import { designTokens } from '@ui/styles';
import { buttonStyles, formControlStyles } from '@ui/styles/controlStyles';
import { toneStyles } from '@ui/styles/toneStyles';
import { isActivationKey } from '@ui/wa/keyActivation';
import {
  renderIconActionButton,
  renderLabeledActionButton,
} from '@ui/wa/actionButtons';
import { actionMenu } from '@ui/wa/actionMenu';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import type {
  ScriptCallView,
  ScriptStageView,
} from '@texra-ai/harness/transcript';
import type { SessionView, RunId } from '@texra-ai/harness/schemas';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

const scriptStageStyles = css`
  :host {
    display: block;
    min-width: 0;
    container-type: inline-size;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
  }

  .section {
    padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-3xs);
    font-weight: var(--font-weight-semibold);
  }

  .summary {
    padding: var(--wa-space-2xs) var(--wa-space-s);
    color: var(--color-text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .log {
    display: flex;
    padding: var(--wa-space-2xs) var(--wa-space-s);
    border-top: var(--border-thin) solid var(--color-border);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-height: 32px;
    min-width: 0;
    padding: var(--wa-space-3xs) var(--wa-space-s);
    border-top: var(--border-thin) solid var(--color-border);
  }

  .row.is-linked {
    cursor: pointer;
  }

  .row.is-linked:hover {
    background: var(--color-bg-secondary);
  }

  .row-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: var(--font-size-xs);
    color: var(--tone-color);
  }

  .row-label {
    flex: 0 0 auto;
    max-width: 40%;
    font-weight: var(--font-weight-semibold);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-last,
  .row-meta,
  .row-rejected {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text-secondary);
  }

  /* The last line takes what the facts leave: a zero basis keeps a long
     line from squeezing the facts to nothing. */
  .row-last {
    flex: 1 1 0;
  }

  .row-last.is-error {
    color: var(--color-error);
  }

  .row-meta {
    flex: 0 1 auto;
    min-width: min(8em, 25%);
    max-width: 35%;
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
  }

  /* Narrow: the facts drop to their own line under the label. */
  @container (max-width: 480px) {
    .row {
      flex-wrap: wrap;
    }

    .row-meta {
      order: 1;
      flex: 1 0 100%;
      max-width: none;
      box-sizing: border-box;
      padding-left: calc(var(--font-size-xs) + var(--wa-space-xs));
    }
  }

  .row-rejected {
    flex: 0 1 auto;
    font-size: var(--font-size-xs);
    color: var(--color-warning);
  }

  .row-actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--wa-space-2xs);
  }
`;

@customElement('script-stage')
export class ScriptStage extends LitElement {
  static override styles = [
    designTokens,
    buttonStyles,
    formControlStyles,
    toneStyles,
    scriptStageStyles,
  ];

  @property({ attribute: false }) stage!: ScriptStageView;
  @property({ attribute: false }) view!: SessionView;
  @property({ attribute: false }) surface!: Surface;
  /** The run whose transcript holds the stage: the Log toggle's key. */
  @property({ attribute: false }) runId: RunId | null = null;
  /** The calls' own cards are open below the card. */
  @property({ type: Boolean }) logOpen = false;

  private select(runId: RunId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', runId }));
  }

  /** Stop the call's child run; the call answers `Skipped`. */
  private stop(runId: RunId): void {
    this.dispatchEvent(
      SessionUiEvents.runtime({ kind: 'run.stop', runId, reason: 'user' }),
    );
  }

  private renderActions(call: ScriptCallView): TemplateResult | typeof nothing {
    if (call.askingRunId !== undefined) {
      const asking = call.askingRunId;
      return html`<span class="row-actions"
        >${renderLabeledActionButton({
          text: 'Review',
          kind: 'primary',
          onClick: (event) => {
            event.stopPropagation();
            this.select(asking);
          },
        })}</span
      >`;
    }
    const child =
      call.childRunId === undefined
        ? undefined
        : this.view.runs.get(call.childRunId);
    if (call.status !== 'running' || child === undefined) return nothing;
    const menu = actionMenu([
      {
        icon: 'circle-stop',
        label: 'Stop this agent',
        activate: () => this.stop(child.id),
      },
    ]);
    return html`<wa-dropdown
      class="row-actions"
      placement="bottom-end"
      @click=${(event: Event) => event.stopPropagation()}
      @wa-select=${menu.onSelect}
      >${renderIconActionButton({
        icon: 'ellipsis',
        slot: 'trigger',
        label: 'More',
      })}${menu.items}</wa-dropdown
    >`;
  }

  private renderCall(call: ScriptCallView): TemplateResult {
    const child =
      call.childRunId === undefined
        ? undefined
        : this.view.runs.get(call.childRunId);
    // A row opens the run that is asking, else its child: for an agent,
    // its conversation, where the composer talks to it.
    const target = call.askingRunId ?? child?.id;
    const talk = call.talkable;
    const last = scriptCallSummary(call) ?? '';
    const rejected =
      child === undefined
        ? undefined
        : this.surface.runs.get(child.id)?.rejected;
    // A call waiting on the user reads as a run waiting on the user does.
    const look: StatusLook = call.needsYou
      ? { tone: 'warning' }
      : SCRIPT_CALL_STATUS_LOOK[call.status];
    return html`<div
      class=${classMap({
        row: true,
        [`tone-${look.tone}`]: true,
        'is-linked': target !== undefined,
      })}
      role="listitem"
      title=${talk ? TALK_TO_AGENT : nothing}
      data-call-id=${call.id}
      tabindex=${target === undefined ? nothing : '0'}
      @click=${target === undefined ? nothing : () => this.select(target)}
      @keydown=${
        target === undefined
          ? nothing
          : (event: KeyboardEvent) => {
              if (!isActivationKey(event)) return;
              event.preventDefault();
              this.select(target);
            }
      }
    >
      <span class="row-icon"
        >${waIcon(statusGlyph(look), {
          label: SCRIPT_CALL_STATUS_LABEL[call.status],
        })}</span
      >
      <bdi class="row-label" dir="auto">${call.label}</bdi>
      <span
        class=${classMap({
          'row-last': true,
          'is-error': call.detail?.kind === 'error',
        })}
        ><bdi dir="auto">${last}</bdi></span
      >
      ${
        rejected === undefined
          ? nothing
          : html`<span class="row-rejected" role="status"
              >${requestErrorText(rejected)}</span
            >`
      }
      ${
        call.facts.length > 0
          ? html`<span class="row-meta">${joinFacts(call.facts)}</span>`
          : nothing
      }
      ${this.renderActions(call)}
      ${
        target === undefined
          ? nothing
          : waIcon(talk ? 'comments' : 'chevron-right', {
              label: talk ? TALK_TO_AGENT : undefined,
            })
      }
    </div>`;
  }

  private toggleLog(): void {
    if (this.runId === null) return;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'group',
        runId: this.runId,
        key: `calls:${this.stage.id}`,
        expanded: !this.logOpen,
      }),
    );
  }

  override render(): TemplateResult {
    const summary = scriptStageSummary(this.stage);
    return html`${
        summary === '' ? nothing : html`<div class="summary">${summary}</div>`
      }
      <div role="list">
        ${repeat(
          this.stage.sections,
          (section) => section.title ?? '',
          (section) =>
            html`${
              section.title === null
                ? nothing
                : html`<div class="section"><bdi>${section.title}</bdi></div>`
            }${repeat(
              section.calls,
              (call) => call.id,
              (call) => this.renderCall(call),
            )}`,
        )}
      </div>
      <div class="log">
        ${renderLabeledActionButton({
          icon: this.logOpen ? 'chevron-down' : 'chevron-right',
          text: 'Log',
          expanded: this.logOpen,
          onClick: () => this.toggleLog(),
        })}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'script-stage': ScriptStage;
  }
}
