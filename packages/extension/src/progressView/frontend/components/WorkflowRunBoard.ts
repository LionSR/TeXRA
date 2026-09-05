/**
 * The run board of a workflow-script stream: one phase strip, the phase's
 * rows in the model's attention-first order, the run's tally, and the
 * controls a run without a chat offers instead of a composer.
 *
 * Reads `stream.transcript.run` (the fold's `workflowRunModel`), the child
 * streams the model joins by row, and the surface's phase, groups, search,
 * and focus. Dispatches `workflow.control` and `stream.stop` runtime
 * requests and `phase`, `group`, `select`, and `focusRow` surface actions;
 * it holds no state of its own. The host passes its clock as `nowMs` (G4).
 */

// Third-party imports
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared contracts
import type {
  AgentCategory,
  PermissionPayload,
  StreamTabId,
  WorkflowCallProgress,
} from '@shared/schemas';
import { designTokens } from '@shared/styles';
import type { WorkflowTaskRow } from '@shared/transcript';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { resolvePhase, type Surface } from '@shared/session/surface';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { formatWorkflowTally } from '@shared/copy/workflowCall';
import {
  formatWorkflowRowGroup,
  workflowPhaseRows,
  type WorkflowPhaseModel,
  type WorkflowPhaseRow,
  type WorkflowRowGroup,
  type WorkflowRunModel,
} from '@shared/streams/workflowRunModel';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { assertNever } from '@utils/core';
import {
  formatCompactDuration,
  formatCompactTokenCount,
  formatCostUsd,
} from '@utils/text/stringUtils';

// Local imports - progress view
import { workflowCallStatusIcon } from '../formatters/logFormatters/workflowCallFormatter';
import { totalRunUsage } from '../usageTotals';
import { workflowRunBoardStyles } from './WorkflowRunBoard.styles';

// Side-effect imports - register Web Awesome components
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';

type WorkflowStreamView = Extract<
  StreamView,
  { readonly category: typeof AgentCategory.Workflow }
>;

/** The bucket a task row leads under; quiet rows carry none. */
type Bucket = 'waiting' | 'failed' | 'running';
const BUCKET_LABEL: Record<Bucket, string> = {
  waiting: 'Needs a decision',
  failed: 'Failed',
  running: 'Running',
};

/** The rows of one phase as the board paints them: section headings
 *  between buckets, and a counted group folding its members in place. */
type Block =
  | {
      readonly kind: 'section';
      readonly bucket: Bucket;
      readonly count: number;
    }
  | { readonly kind: 'row'; readonly row: WorkflowPhaseRow }
  | {
      readonly kind: 'fold';
      readonly group: Extract<WorkflowPhaseRow, { kind: 'group' }>;
      readonly members: readonly WorkflowPhaseRow[];
    };

/** What a waiting child asks for, in the words the terminal's rows use. */
function approvalLine(payload: PermissionPayload): string {
  switch (payload.kind) {
    case 'bash':
      return `Wants bash: ${payload.data.command}`;
    case 'toolEdit':
      return `Wants edit: ${payload.data.relativePath}`;
    case 'retry':
      return `Wants retry: ${payload.data.operation}`;
    case 'proposal':
      return 'Wants approval for a proposal';
    case 'planApproval':
      return 'Wants approval for a plan';
    case 'externalInquiry':
      return 'Wants an answer to an inquiry';
    case 'userQuestion':
      return 'Wants an answer to a question';
    default:
      return assertNever(payload, 'Unhandled approval kind');
  }
}

function blockKey(block: Block, index: number): string {
  switch (block.kind) {
    case 'row':
      return block.row.key;
    case 'fold':
      return block.group.key;
    case 'section':
      return `section:${block.bucket}:${index}`;
  }
}

/** A group's surface key: the phase, then the group, so two phases keep
 *  their own folds. */
function groupKey(phaseKey: string, group: WorkflowRowGroup): string {
  return `${phaseKey}#${group}`;
}

@customElement('workflow-run-board')
export class WorkflowRunBoard extends LitElement {
  static override styles = [designTokens, workflowRunBoardStyles];

  @property({ attribute: false }) stream!: WorkflowStreamView;
  @property({ attribute: false }) view!: SessionView;
  @property({ attribute: false }) surface!: Surface;
  /** The host's clock; null shows no elapsed time. */
  @property({ type: Number }) nowMs: number | null = null;
  /** The desktop's headline: the tally leads the strip instead of closing
   *  the board. */
  @property({ type: Boolean, reflect: true }) summary = false;

  private get run(): WorkflowRunModel | null {
    return this.stream.transcript.run;
  }

  /** The child a card opened, when the model resolved one. */
  private childOf(rowId: string): StreamView | undefined {
    const childId = this.run?.childStreamOf.get(rowId);
    return childId === undefined ? undefined : this.view.streams.get(childId);
  }

  /** The card's child run needs the user: its own approval, or one of
   *  its descendants'. */
  private waiting(rowId: string): boolean {
    const approval = this.childOf(rowId)?.approval;
    return approval !== undefined && approval !== 'none';
  }

  /** The approval a card's child is waiting on, if any. */
  private approvalOf(rowId: string): PermissionPayload | undefined {
    const child = this.childOf(rowId);
    if (!child || child.approval === 'none') return undefined;
    return this.view.approvals.find((entry) => entry.streamId === child.id)
      ?.payload;
  }

  private bucketOf(row: WorkflowTaskRow): Bucket | undefined {
    if (this.waiting(row.id)) return 'waiting';
    if (row.call.status === 'failed') return 'failed';
    if (row.call.status === 'running') return 'running';
    return undefined;
  }

  private expandedGroups(phaseKey: string): ReadonlySet<WorkflowRowGroup> {
    const groups = this.surface.groups.get(this.stream.id);
    const expanded = new Set<WorkflowRowGroup>();
    for (const group of ['finished', 'queued', 'declared'] as const) {
      if (groups?.get(groupKey(phaseKey, group)) === true) expanded.add(group);
    }
    return expanded;
  }

  private rowsOf(phase: WorkflowPhaseModel): readonly WorkflowPhaseRow[] {
    const waiting = new Set(
      phase.tasks
        .filter((task) => this.waiting(task.id))
        .map((task) => task.id),
    );
    return workflowPhaseRows(phase, {
      expanded: this.expandedGroups(phase.key),
      filter: this.surface.search,
      waiting,
    });
  }

  private blocksOf(phase: WorkflowPhaseModel): readonly Block[] {
    const rows = this.rowsOf(phase);
    const blocks: Block[] = [];
    let bucket: Bucket | undefined;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.kind === 'group') {
        // The model lists an open group's members right after its header.
        const members: WorkflowPhaseRow[] = [];
        while (row.expanded && rows[index + 1]?.kind !== 'group') {
          const member = rows[index + 1];
          if (!member) break;
          members.push(member);
          index += 1;
        }
        blocks.push({ kind: 'fold', group: row, members });
        bucket = undefined;
        continue;
      }
      const next = row.kind === 'task' ? this.bucketOf(row.row) : undefined;
      if (next !== undefined && next !== bucket) {
        let count = 0;
        for (let peek = index; peek < rows.length; peek += 1) {
          const candidate = rows[peek]!;
          if (candidate.kind !== 'task') break;
          if (this.bucketOf(candidate.row) !== next) break;
          count += 1;
        }
        blocks.push({ kind: 'section', bucket: next, count });
      }
      bucket = next;
      blocks.push({ kind: 'row', row });
    }
    return blocks;
  }

  // -- events --------------------------------------------------------------

  private control(rowId: string, action: 'skip' | 'retry'): void {
    const child = this.childOf(rowId);
    if (!child) return;
    this.dispatchEvent(
      SessionUiEvents.runtime({
        kind: 'workflow.control',
        streamId: this.stream.id,
        executionId: child.executionId,
        action,
      }),
    );
  }

  private select(streamId: StreamTabId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', streamId }));
  }

  private handleTabShow(event: CustomEvent<{ name: string }>): void {
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'phase',
        streamId: this.stream.id,
        phase: event.detail.name,
      }),
    );
  }

  private toggleGroup(key: string, expanded: boolean): void {
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'group',
        streamId: this.stream.id,
        key,
        expanded,
      }),
    );
  }

  private killRun(): void {
    this.dispatchEvent(
      SessionUiEvents.runtime({
        kind: 'stream.stop',
        streamId: this.stream.id,
      }),
    );
  }

  /** Every failed card with a child to retry, in phase order. */
  private failedRows(): readonly { phase: string; row: WorkflowTaskRow }[] {
    return (this.run?.phases ?? []).flatMap((phase) =>
      phase.tasks
        .filter((row) => row.call.status === 'failed')
        .map((row) => ({ phase: phase.key, row })),
    );
  }

  private retryFailed(): void {
    for (const { row } of this.failedRows()) this.control(row.id, 'retry');
  }

  /** Focus the failed card after the focused one, wrapping, and show its
   *  phase. */
  private nextFailed(): void {
    const failed = this.failedRows();
    if (failed.length === 0) return;
    const current = failed.findIndex(
      ({ row }) => row.id === this.surface.focusedRow,
    );
    const next = failed[(current + 1) % failed.length]!;
    this.dispatchEvent(
      SessionUiEvents.surface({
        kind: 'phase',
        streamId: this.stream.id,
        phase: next.phase,
      }),
    );
    this.dispatchEvent(
      SessionUiEvents.surface({ kind: 'focusRow', rowId: next.row.id }),
    );
  }

  // -- render --------------------------------------------------------------

  private renderStatusCount(
    status: WorkflowCallProgress['status'],
    count: number,
  ): TemplateResult | typeof nothing {
    if (count === 0) return nothing;
    return html`<span
      class="quiet tone-${status === 'failed' ? 'danger' : 'running'}"
      >${waIcon(workflowCallStatusIcon(status))} ${count}
      ${this.summary ? status : nothing}</span
    >`;
  }

  /** `↓41k · $1.84 · 38m`: what the run has produced and spent so far. */
  private renderUsage(): TemplateResult {
    const usage = totalRunUsage(this.stream.usage);
    const { runStartedAt } = this.stream;
    const parts = [
      usage.outputTokens > 0
        ? `↓${formatCompactTokenCount(usage.outputTokens)}`
        : undefined,
      usage.cost > 0 ? formatCostUsd(usage.cost) : undefined,
      !this.summary && runStartedAt !== null && this.nowMs !== null
        ? formatCompactDuration(this.nowMs - runStartedAt)
        : undefined,
    ].filter((part) => part !== undefined);
    return html`<span class="quiet">${parts.join(' · ')}</span>`;
  }

  private renderSummary(run: WorkflowRunModel): TemplateResult {
    const { tally } = run;
    return html`<div class="summary">
      <wa-badge variant="neutral" appearance="outlined" pill
        >${tally.done} / ${tally.total}</wa-badge
      >
      ${this.renderStatusCount('running', tally.running)}
      ${this.renderStatusCount('failed', tally.failed)}
      <span class="spacer"></span>
      ${this.renderUsage()}
    </div>`;
  }

  private renderTally(run: WorkflowRunModel): TemplateResult {
    return html`<div class="tally">
      <span>${formatWorkflowTally(run.tally)}</span>
      <span>·</span>
      ${this.renderUsage()}
    </div>`;
  }

  /** What the tab flags: calls waiting on the user first, else failures. */
  private renderTabBadge(
    phase: WorkflowPhaseModel,
  ): TemplateResult | typeof nothing {
    const waiting = phase.tasks.filter((task) => this.waiting(task.id)).length;
    if (waiting > 0) {
      return html`<wa-badge variant="warning" pill>${waiting}</wa-badge>`;
    }
    if (phase.tally.failed > 0) {
      return html`<wa-badge variant="danger" pill
        >${phase.tally.failed}</wa-badge
      >`;
    }
    return nothing;
  }

  private renderTab(phase: WorkflowPhaseModel): TemplateResult {
    const badge = this.renderTabBadge(phase);
    return html`<wa-tab panel=${phase.key}
      ><span
        class=${classMap({ 'phase-tab': true, 'is-declared': !phase.opened })}
        >${phase.opened ? waIcon('diagram-project') : nothing}
        <span>${phase.heading.phaseLabel}</span>
        ${
          phase.opened
            ? html`<span class="quiet"
                >${phase.tally.done}/${phase.tally.total}</span
              >`
            : nothing
        }
        ${badge}</span
      ></wa-tab
    >`;
  }

  /** A waiting card opens its child; a failed one retries or skips. */
  private renderActions(
    row: WorkflowTaskRow,
    child: StreamView | undefined,
    waiting: boolean,
  ): TemplateResult | typeof nothing {
    if (waiting && child) {
      return html`<span class="row-actions"
        ><wa-button
          size="s"
          variant="brand"
          @click=${(event: Event) => {
            event.stopPropagation();
            this.select(child.id);
          }}
          >Review (y/n)</wa-button
        ></span
      >`;
    }
    if (row.call.status !== 'failed') return nothing;
    const canAct = !this.stream.readOnly && child !== undefined;
    return html`<span class="row-actions"
      ><wa-button
        size="s"
        appearance="outlined"
        ?disabled=${!canAct}
        @click=${(event: Event) => {
          event.stopPropagation();
          this.control(row.id, 'retry');
        }}
        >${waIcon('rotate-right', { slot: 'start' })} Retry</wa-button
      ><wa-button
        size="s"
        appearance="outlined"
        ?disabled=${!canAct}
        @click=${(event: Event) => {
          event.stopPropagation();
          this.control(row.id, 'skip');
        }}
        >${waIcon('forward-step', { slot: 'start' })} Skip</wa-button
      ></span
    >`;
  }

  /** `attempt 2`, `6m · ↓4k`: what a row shows beside its last line. The
   *  card's kind, agent, and model stay in the child's header; the board
   *  keeps the attempt, the elapsed time while it runs, and its tokens. */
  private rowMeta(row: WorkflowTaskRow): readonly string[] {
    const { call } = row;
    const live = this.run?.liveOf.get(row.id);
    return [
      call.attemptNumber === undefined
        ? undefined
        : `attempt ${call.attemptNumber}`,
      call.status === 'running' &&
      live?.runStartedAt !== undefined &&
      this.nowMs !== null
        ? formatCompactDuration(this.nowMs - live.runStartedAt)
        : undefined,
      live?.outputTokens !== undefined && live.outputTokens > 0
        ? `↓${formatCompactTokenCount(live.outputTokens)}`
        : undefined,
    ].filter((part) => part !== undefined);
  }

  private renderTask(row: WorkflowTaskRow): TemplateResult {
    const { call } = row;
    const child = this.childOf(row.id);
    const approval = this.approvalOf(row.id);
    const waiting = approval !== undefined;
    const meta = this.rowMeta(row);
    const last = waiting
      ? approvalLine(approval)
      : (row.detail?.text ?? child?.latestLine ?? child?.statusLabel ?? '');
    const actions = this.renderActions(row, child, waiting);
    return html`<div
      class=${classMap({
        row: true,
        [`status-${call.status}`]: true,
        'is-waiting': waiting,
        'is-linked': child !== undefined,
        'is-focused': this.surface.focusedRow === row.id,
      })}
      role="listitem"
      data-row-id=${row.id}
      tabindex=${child ? '0' : nothing}
      @click=${child ? () => this.select(child.id) : nothing}
      @keydown=${
        child
          ? (event: KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              this.select(child.id);
            }
          : nothing
      }
    >
      <span class="row-icon"
        >${waIcon(waiting ? 'circle-dot' : workflowCallStatusIcon(call.status))}</span
      >
      <bdi class="row-label" dir="auto">${call.label}</bdi>
      <span
        class=${classMap({
          'row-last': true,
          'is-error': !waiting && row.detail?.kind === 'error',
        })}
        ><bdi dir="auto">${last}</bdi></span
      >
      ${
        meta.length > 0
          ? html`<span class="row-meta">${meta.join(' · ')}</span>`
          : nothing
      }
      ${actions}
      ${child ? html`<span class="row-open">${waIcon('chevron-right')}</span>` : nothing}
    </div>`;
  }

  private renderRow(row: WorkflowPhaseRow): TemplateResult {
    switch (row.kind) {
      case 'task':
        return this.renderTask(row.row);
      case 'declared':
        return html`<div class="row status-declared" role="listitem">
          <span class="row-icon">${waIcon('circle')}</span>
          <bdi class="row-label" dir="auto">${row.task.label}</bdi>
          <span class="row-last">Declared</span>
        </div>`;
      case 'group':
        // A group row reaches the board only as a fold's header.
        return html`<div class="row" role="listitem">
          ${formatWorkflowRowGroup(row)}
        </div>`;
    }
  }

  private renderBlock(phaseKey: string, block: Block): TemplateResult {
    switch (block.kind) {
      case 'section':
        return html`<div class="section">
          <span>${BUCKET_LABEL[block.bucket]}</span>
          <span class="count">${block.count}</span>
        </div>`;
      case 'row':
        return this.renderRow(block.row);
      case 'fold': {
        const key = groupKey(phaseKey, block.group.group);
        return html`<wa-details
          class="fold"
          ?open=${block.group.expanded}
          @wa-show=${(event: Event) => {
            event.stopPropagation();
            this.toggleGroup(key, true);
          }}
          @wa-hide=${(event: Event) => {
            event.stopPropagation();
            this.toggleGroup(key, false);
          }}
        >
          <span slot="summary">${formatWorkflowRowGroup(block.group)}</span>
          ${repeat(
            block.members,
            (member) => member.key,
            (member) => this.renderRow(member),
          )}
        </wa-details>`;
      }
    }
  }

  private renderPhase(phase: WorkflowPhaseModel, active: boolean) {
    return html`<wa-tab-panel name=${phase.key}
      >${
        active
          ? html`<div class="rows" role="list">
              ${repeat(this.blocksOf(phase), blockKey, (block) =>
                this.renderBlock(phase.key, block),
              )}
            </div>`
          : nothing
      }</wa-tab-panel
    >`;
  }

  private renderControls(): TemplateResult {
    const failed = this.failedRows().length;
    const disabled = this.stream.readOnly;
    return html`<div class="controls">
      <wa-button
        size="s"
        appearance="outlined"
        ?disabled=${failed === 0}
        @click=${this.nextFailed}
        >Next failed</wa-button
      >
      <wa-button
        size="s"
        appearance="outlined"
        ?disabled=${disabled || failed === 0}
        @click=${this.retryFailed}
        >Retry failed</wa-button
      >
      <span class="note"
        ><span class="note-narrow">This run has no chat</span
        ><span class="note-wide"
          >Skip and retry are per call; Kill is the run's stop.</span
        ></span
      >
      <wa-button
        size="s"
        variant="danger"
        appearance="outlined"
        ?disabled=${disabled || this.stream.durableOutcome !== null}
        @click=${this.killRun}
        >Kill run</wa-button
      >
    </div>`;
  }

  override render(): TemplateResult | typeof nothing {
    const run = this.run;
    if (!run) return nothing;
    const active = resolvePhase(this.surface, this.stream.id, run.phases);
    return html`${this.summary ? this.renderSummary(run) : nothing}
      <wa-tab-group
        class="phases"
        active=${active ?? nothing}
        @wa-tab-show=${this.handleTabShow}
      >
        ${repeat(
          run.phases,
          (phase) => phase.key,
          (phase) => this.renderTab(phase),
        )}
        ${repeat(
          run.phases,
          (phase) => phase.key,
          (phase) => this.renderPhase(phase, phase.key === active),
        )}
      </wa-tab-group>
      ${this.summary ? nothing : this.renderTally(run)}
      ${
        this.stream.followUpSupport === 'unsupported'
          ? this.renderControls()
          : nothing
      }`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'workflow-run-board': WorkflowRunBoard;
  }
}
