/**
 * `<script-stage>`: the calls one `script` call issued, painted from the
 * shared script-stage model (`scriptStages` in `@ui/transcript`). Each phase
 * leads with the calls that need a decision, then the failed and the running
 * ones, then the rest in issue order. An `agent` row opens its child run;
 * Review opens the run that is asking; Skip stops a running call's child,
 * which the call then answers as `Skipped`. Holds no state: every send is a
 * surface or runtime event.
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
  SCRIPT_SECTION_LABEL,
  type ScriptCallView,
  type ScriptStageView,
} from '@ui/transcript';
import { terminalStatusIcon } from '@ui/wa/statusIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';
import { formatCostUsd } from '@utils/text/stringUtils';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

function statusIcon(
  status: ScriptCallView['status'],
): Parameters<typeof waIcon>[0] {
  switch (status) {
    case 'queued':
      return 'circle-dot';
    case 'running':
      return terminalStatusIcon('running');
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

/** The runtime's refusal of a skip, in the runtime's words. */
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
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-normal);
  }

  .phase {
    padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-3xs);
    font-weight: var(--wa-font-weight-semibold);
  }

  .section {
    display: flex;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    font-weight: var(--wa-font-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wa-color-text-quiet);
  }

  .section .count {
    font-weight: var(--wa-font-weight-normal);
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

  .is-waiting .row-icon {
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

  .row-last {
    flex: 1 1 auto;
  }

  .row-last.is-error {
    color: var(--wa-color-danger-on-quiet);
  }

  .row-meta {
    flex: 0 1 auto;
    max-width: 35%;
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
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

  private select(runId: RunId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', runId }));
  }

  /** Skip: stop the call's child run; the call answers `Skipped`. */
  private skip(runId: RunId): void {
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
    return html`<span class="row-actions"
      ><wa-button
        size="s"
        appearance="outlined"
        ?disabled=${this.readOnly || child.readOnly}
        title="Stop this call's agent run; the script gets a Skipped error"
        @click=${(event: Event) => {
          event.stopPropagation();
          this.skip(child.id);
        }}
        >${waIcon('forward-step', { slot: 'start' })} Skip</wa-button
      ></span
    >`;
  }

  private renderCall(call: ScriptCallView): TemplateResult {
    const child =
      call.childRunId === undefined
        ? undefined
        : this.view.runs.get(call.childRunId);
    // A row opens the run that is asking, else its child.
    const target = call.askingRunId ?? child?.id;
    const last = call.detail?.text ?? child?.latestLine ?? '';
    const rejected =
      child === undefined ? undefined : this.surface.rejected.get(child.id);
    return html`<div
      class=${classMap({
        row: true,
        [`status-${call.status.replace(' ', '-')}`]: true,
        'is-waiting': call.section === 'waiting',
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
        >${waIcon(
          call.section === 'waiting' ? 'circle-dot' : statusIcon(call.status),
          { label: SCRIPT_CALL_STATUS_LABEL[call.status] },
        )}</span
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

  override render(): TemplateResult {
    return html`<div role="list">
      ${repeat(
        this.stage.phases,
        (phase) => phase.title ?? '',
        (phase) =>
          html`${
            phase.title === null
              ? nothing
              : html`<div class="phase"><bdi>${phase.title}</bdi></div>`
          }${repeat(
            phase.sections,
            (group) => group.section ?? 'rest',
            (group) =>
              html`${
                group.section === null
                  ? nothing
                  : html`<div class="section">
                      <span>${SCRIPT_SECTION_LABEL[group.section]}</span>
                      <span class="count">${group.calls.length}</span>
                    </div>`
              }${repeat(
                group.calls,
                (call) => call.id,
                (call) => this.renderCall(call),
              )}`,
          )}`,
      )}
      ${
        this.stage.costUsd > 0
          ? html`<div class="section">
              <span>Total</span>
              <span class="count">${formatCostUsd(this.stage.costUsd)}</span>
            </div>`
          : nothing
      }
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'script-stage': ScriptStage;
  }
}
