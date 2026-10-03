/**
 * `<script-stage>`: the calls one `script` call issued, painted from the
 * shared script-stage model (`scriptStages` in `@ui/transcript`): the card's
 * summary line, then each phase's calls as plain rows in issue order. An
 * `agent` row opens its child run; Review opens the run that is asking;
 * "Stop this agent", in a running row's menu, stops the call's child, which
 * the call then answers as `Skipped`. "Log" opens the calls' own cards
 * below the card. Holds no state: every send is a surface or runtime event.
 */

// Third-party imports
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared contracts
import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { Surface, SurfaceRefusal } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { designTokens } from '@ui/styles';
import {
  SCRIPT_CALL_STATUS_LABEL,
  type ScriptCallView,
  type ScriptStageView,
} from '@ui/transcript';
import { terminalStatusIcon } from '@ui/wa/statusIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';
import type WaDropdownItem from '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

/** The row menu's one item: stop the call's child run. */
const STOP_AGENT = 'stop-agent';

function statusIcon(
  status: ScriptCallView['status'],
): Parameters<typeof waIcon>[0] {
  switch (status) {
    case 'queued':
      return 'circle-dot';
    case 'running':
      return terminalStatusIcon('running');
    case 'interrupted':
      // As an interrupted compaction reads: nothing runs it until Resume.
      return 'circle-exclamation';
    case 'finished':
      return terminalStatusIcon('completed');
    case 'reused':
      // A result an earlier call produced: nothing ran this time.
      return 'clock-rotate-left';
    case 'skipped':
    case 'cancelled':
    case 'not run':
      return terminalStatusIcon('cancelled');
    case 'failed':
      return terminalStatusIcon('failed');
    default:
      return assertNever(status, 'Unhandled script call status');
  }
}

/** The runtime's refusal of a stop, in the runtime's words. */
function refusalText(error: SurfaceRefusal): string {
  switch (error._tag) {
    case 'NotOwner':
      return 'This run is controlled by another TeXRA window.';
    case 'Internal':
      return `The request failed. See the TeXRA log (reference ${error.ref}).`;
    default:
      return error.reason;
  }
}

const scriptStageStyles = css`
  :host {
    display: block;
    min-width: 0;
    container-type: inline-size;
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
  }

  .phase {
    padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-3xs);
    font-weight: var(--wa-font-weight-semibold);
  }

  .summary {
    padding: var(--wa-space-2xs) var(--wa-space-s);
    color: var(--wa-color-text-quiet);
    font-variant-numeric: tabular-nums;
  }

  .log {
    display: flex;
    padding: var(--wa-space-2xs) var(--wa-space-s);
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-height: 32px;
    min-width: 0;
    padding: var(--wa-space-3xs) var(--wa-space-s);
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .row.is-linked {
    cursor: pointer;
  }

  .row.is-linked:hover {
    background: var(--wa-color-surface-lowered);
  }

  .row-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--wa-color-text-quiet);
  }

  .status-running .row-icon,
  .status-finished .row-icon,
  .status-reused .row-icon {
    color: var(--wa-color-success-on-quiet);
  }

  .status-failed .row-icon {
    color: var(--wa-color-danger-on-quiet);
  }

  .status-interrupted .row-icon,
  .needs-you .row-icon {
    color: var(--wa-color-warning-on-quiet);
  }

  .row-label {
    flex: 0 0 auto;
    max-width: 40%;
    font-weight: var(--wa-font-weight-semibold);
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
    color: var(--wa-color-text-quiet);
  }

  /* The last line takes what the facts leave: a zero basis keeps a long
     line from squeezing the facts to nothing. */
  .row-last {
    flex: 1 1 0;
  }

  .row-last.is-error {
    color: var(--wa-color-danger-on-quiet);
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
      padding-left: calc(12px + var(--wa-space-xs));
    }
  }

  .row-rejected {
    flex: 0 1 auto;
    font-size: var(--font-size-xs);
    color: var(--wa-color-warning-on-quiet);
  }

  .row-actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--wa-space-2xs);
  }
`;

@customElement('script-stage')
export class ScriptStage extends LitElement {
  static override styles = [designTokens, scriptStageStyles];

  @property({ attribute: false }) stage!: ScriptStageView;
  @property({ attribute: false }) view!: SessionView;
  @property({ attribute: false }) surface!: Surface;
  /** The run the stage belongs to cannot act here (another owner, ended). */
  @property({ type: Boolean }) readOnly = false;
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
        ><wa-button
          size="s"
          variant="brand"
          @click=${(event: Event) => {
            event.stopPropagation();
            this.select(asking);
          }}
          >Review</wa-button
        ></span
      >`;
    }
    const child =
      call.childRunId === undefined
        ? undefined
        : this.view.runs.get(call.childRunId);
    if (call.status !== 'running' || child === undefined) return nothing;
    return html`<wa-dropdown
      class="row-actions"
      placement="bottom-end"
      @click=${(event: Event) => event.stopPropagation()}
      @wa-select=${(event: WaSelectEvent) => {
        if ((event.detail.item as WaDropdownItem).value === STOP_AGENT)
          this.stop(child.id);
      }}
      ><wa-button
        slot="trigger"
        size="s"
        appearance="plain"
        variant="neutral"
        aria-label="More"
        >${waIcon('ellipsis')}</wa-button
      ><wa-dropdown-item
        value=${STOP_AGENT}
        ?disabled=${this.readOnly || child.readOnly}
        >${waIcon('circle-stop', { slot: 'icon' })}Stop this
        agent</wa-dropdown-item
      ></wa-dropdown
    >`;
  }

  private renderCall(call: ScriptCallView): TemplateResult {
    const child =
      call.childRunId === undefined
        ? undefined
        : this.view.runs.get(call.childRunId);
    // A row opens the run that is asking, else its child.
    const target = call.askingRunId ?? child?.id;
    const last = call.summary ?? '';
    const rejected =
      child === undefined ? undefined : this.surface.rejected.get(child.id);
    return html`<div
      class=${classMap({
        row: true,
        [`status-${call.status.replace(' ', '-')}`]: true,
        'needs-you': call.needsYou,
        'is-linked': target !== undefined,
      })}
      role="listitem"
      data-call-id=${call.id}
      tabindex=${target === undefined ? nothing : '0'}
      @click=${target === undefined ? nothing : () => this.select(target)}
      @keydown=${
        target === undefined
          ? nothing
          : (event: KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              this.select(target);
            }
      }
    >
      <span class="row-icon"
        >${waIcon(call.needsYou ? 'circle-dot' : statusIcon(call.status), {
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
              >${refusalText(rejected)}</span
            >`
      }
      ${
        call.facts.length > 0
          ? html`<span class="row-meta">${call.facts.join(' · ')}</span>`
          : nothing
      }
      ${this.renderActions(call)}
      ${target === undefined ? nothing : waIcon('chevron-right')}
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
    return html`${
        this.stage.summary === ''
          ? nothing
          : html`<div class="summary">${this.stage.summary}</div>`
      }
      <div role="list">
        ${repeat(
          this.stage.phases,
          (phase) => phase.title ?? '',
          (phase) =>
            html`${
              phase.title === null
                ? nothing
                : html`<div class="phase"><bdi>${phase.title}</bdi></div>`
            }${repeat(
              phase.calls,
              (call) => call.id,
              (call) => this.renderCall(call),
            )}`,
        )}
      </div>
      <div class="log">
        <wa-button
          size="s"
          appearance="plain"
          variant="neutral"
          aria-expanded=${this.logOpen ? 'true' : 'false'}
          @click=${() => this.toggleLog()}
          >${waIcon(this.logOpen ? 'chevron-down' : 'chevron-right', {
            slot: 'start',
          })}Log</wa-button
        >
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'script-stage': ScriptStage;
  }
}
