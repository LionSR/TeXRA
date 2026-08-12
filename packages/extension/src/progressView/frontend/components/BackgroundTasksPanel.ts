/**
 * Collapsible panel for displaying background tasks (subagents and inquiries).
 *
 * Uses `<wa-details>` for the outer panel, and — only when both the Subagents
 * and Inquiries sections are populated — a nested `.collapsible-quiet`
 * `<wa-details>` per section; a lone section renders its rows directly under
 * the outer panel. Each subagent row is clickable to navigate to
 * its stream tab — finished ones included, their tab is still there. Processes
 * don't have their own tab so they are not clickable.
 *
 * Rows are live children followed by the finished children the backend retains
 * (`ActiveChildInfo.finishedAt`); finished process (background bash) rows are
 * ephemeral and filtered out here. This panel never counts what it cannot list.
 */

// Third-party imports
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { consume } from '@lit/context';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import {
  STREAM_PHASE,
  runIdentityDisplayName,
  type ActiveChildInfo,
  type InquiryThreadUpdatedEvent,
} from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import {
  formatPhaseStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { ProgressEvents } from '../events';

// Local imports - contexts
import {
  EMPTY_INQUIRY_THREADS,
  EMPTY_PHASE_STAGE_MAP,
  EMPTY_STREAM_BY_ID,
  inquiryThreadsContext,
  phaseStagesContext,
  streamByIdContext,
  type PhaseStageMap,
  type StreamByIdMap,
} from '../streamContexts';

// Web Awesome native components
import '@awesome.me/webawesome/dist/components/details/details.js';

@customElement('background-tasks-panel')
export class BackgroundTasksPanel extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .task-list {
        display: flex;
        flex-direction: column;
      }

      /* The shared panel header already supplies the section boundary and
         lowered surface. Strip Web Awesome's surrounding card so expanding
         Background tasks does not introduce a second white, rounded panel
         around the quiet child sections. */
      wa-details.panel-collapsible::part(base) {
        background: transparent;
        border: none;
        border-radius: 0;
      }

      .section-content {
        max-height: clamp(12rem, 42vh, 24rem);
        overflow-y: auto;
        scrollbar-gutter: stable;
      }

      .task-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-height: 1.5rem;
        padding: 1px 0;
        font-size: var(--font-size-sm);
        line-height: var(--line-height-tight);
      }

      .task-icon {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
      }

      .task-icon--process {
        color: var(--color-warning);
      }

      .task-icon--subagent {
        color: var(--color-info);
      }

      .task-icon--inquiry {
        color: var(--wa-color-brand-fill-loud);
      }

      .task-name {
        flex: 0 1 auto;
        max-width: min(14rem, 40%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--wa-color-text-normal);
      }

      .task-name--clickable {
        cursor: pointer;
        color: var(--color-text-link);
        text-decoration: underline;
        text-decoration-color: transparent;
        transition: text-decoration-color var(--transition-fast);
      }

      .task-name--clickable:hover {
        text-decoration-color: var(--wa-color-text-normal);
      }

      /* Sits between the name and the description: a run's phase identifies
         where it is, so it shrinks only to an ellipsis floor and never wraps
         the row. */
      .task-phase {
        flex: 0 1 auto;
        min-width: 6ch;
        max-width: 10rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .task-description {
        flex: 1 1 8rem;
        min-width: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .task-elapsed {
        flex-shrink: 0;
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      .inquiry-id {
        flex: 0 0 auto;
        font-family: var(--wa-font-family-code);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
      }

      /* Status uses a native wa-badge (filled), matching the app-wide badge
         idiom (GoalTab / WorktreeChip / StreamHeader goal chip) rather than a
         wa-tag — tags are for removable/category chips, badges for status. */
      wa-badge.task-status {
        flex: 0 0 auto;
        margin-inline-start: auto;
      }

      wa-badge.task-status::part(base) {
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-medium);
      }

      /* Nested sections use Web Awesome <wa-details class="collapsible-quiet">
         in place of a hand-rolled <details>; the section label lives in the
         summary slot and keeps the uppercase small-caps look. wa-details
         supplies the disclosure chevron, so no hand-rolled toggle icon. */
      wa-details.collapsible-quiet::part(header) {
        padding-inline: 0;
      }

      .section-label {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: var(--letter-spacing-caps);
      }

      .section-label:hover {
        color: var(--wa-color-text-normal);
      }

      .section-label wa-icon {
        font-size: var(--font-size-xs);
      }
    `,
  ];

  /** Live children plus the finished ones retained for display (`finishedAt`). */
  @property({ attribute: false }) subagents: ActiveChildInfo[] = [];

  /** Select the complete background view or the inquiry-only workflow view. */
  @property() scope: 'all' | 'inquiries' = 'all';

  /** Open state — auto-expands when active tasks appear, auto-collapses when all finish. */
  @state() open = false;

  @consume({ context: streamByIdContext, subscribe: true })
  @state()
  private streamById: StreamByIdMap = EMPTY_STREAM_BY_ID;

  @consume({ context: inquiryThreadsContext, subscribe: true })
  @state()
  private inquiries: InquiryThreadUpdatedEvent[] = EMPTY_INQUIRY_THREADS;

  /** Current phase per stream — a workflow-script run's row is otherwise
   *  indistinguishable at minute 2 and minute 38 of the same run. */
  @consume({ context: phaseStagesContext, subscribe: true })
  @state()
  private phaseStages: PhaseStageMap = EMPTY_PHASE_STAGE_MAP;

  /** Track previous active count to detect transitions. */
  private prevActiveCount = 0;

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const active =
      (this.scope === 'all'
        ? this.subagents.filter((child) => child.finishedAt === undefined)
            .length
        : 0) +
      this.inquiries.filter((thread) => thread.status === 'open').length;
    // Auto-open when tasks appear (0 → N), auto-close when all finish (N → 0)
    if (this.prevActiveCount === 0 && active > 0) {
      this.open = true;
    } else if (this.prevActiveCount > 0 && active === 0) {
      this.open = false;
    }
    this.prevActiveCount = active;
  }

  override render(): TemplateResult | typeof nothing {
    // Finished process children (background bash) are ephemeral — hide them
    // even if a retained roster row still arrives from an older snapshot.
    const visibleSubagents =
      this.scope === 'all'
        ? this.subagents.filter(
            (child) =>
              !(
                child.identity?.kind === 'process' &&
                child.finishedAt !== undefined
              ),
          )
        : [];
    if (visibleSubagents.length + this.inquiries.length === 0) {
      return nothing;
    }

    // With a single populated section, the inner disclosure header is pure
    // chrome — render the list directly under the outer panel instead.
    const withSectionHeaders =
      visibleSubagents.length > 0 && this.inquiries.length > 0;

    return html`
      <wa-details
        class="panel-collapsible"
        summary=${this.scope === 'inquiries' ? 'Inquiries' : 'Background tasks'}
        ?open=${this.open}
        @wa-show=${this.handleOpenToggle}
        @wa-hide=${this.handleOpenToggle}
      >
        <div class="task-list">
          ${this.renderSection(visibleSubagents, withSectionHeaders)}
          ${this.renderInquirySection(withSectionHeaders)}
        </div>
      </wa-details>
    `;
  }

  private renderInquirySection(
    withHeader: boolean,
  ): TemplateResult | typeof nothing {
    return this.renderSectionRows(
      this.inquiries,
      (thread) => thread.threadId,
      (thread, index) => this.renderInquiryItem(thread, index),
      withHeader,
      {
        icon: 'comments',
        label: 'Inquiries',
        counts: (['open', 'answered', 'dropped'] as const)
          .map((status) => ({
            status,
            count: this.inquiries.filter((t) => t.status === status).length,
          }))
          .filter(({ count }) => count > 0)
          .map(({ status, count }) => `${count} ${status}`),
        open: true,
      },
    );
  }

  private renderInquiryItem(
    thread: InquiryThreadUpdatedEvent,
    index: number,
  ): TemplateResult {
    const preview = thread.lastQuestionPreview || '(empty question)';
    const idPrefix = `background-inquiry-${index}`;
    return html`
      <div class="task-header">
        ${waIcon('circle-question', { className: 'task-icon task-icon--inquiry' })}
        <span class="inquiry-id">${thread.threadId}</span>
        <span id="${idPrefix}-description" class="task-description"
          >${preview}</span
        >
        <wa-tooltip for="${idPrefix}-description">${preview}</wa-tooltip>
        <wa-relative-time
          id="${idPrefix}-elapsed"
          class="task-elapsed"
          date=${thread.lastActivityIso}
          format="narrow"
          sync
        ></wa-relative-time>
        <wa-tooltip for="${idPrefix}-elapsed"
          >${thread.lastActivityIso}</wa-tooltip
        >
        <wa-badge
          class="task-status"
          variant=${inquiryStatusVariant(thread.status)}
          appearance="filled"
          >${thread.status}</wa-badge
        >
      </div>
    `;
  }

  private renderSection(
    children: ActiveChildInfo[],
    withHeader: boolean,
  ): TemplateResult | typeof nothing {
    const activeCount = children.filter(
      (child) => child.finishedAt === undefined,
    ).length;
    const finishedCount = children.length - activeCount;

    return this.renderSectionRows(
      children,
      (c) => c.executionId,
      (c, index) => this.renderTaskItem(c, index),
      withHeader,
      {
        icon: 'server',
        label: 'Subagents',
        counts: [
          ...(activeCount ? [`${activeCount} active`] : []),
          ...(finishedCount ? [`${finishedCount} done`] : []),
        ],
        open: false,
      },
    );
  }

  /**
   * Shared section shape: guard against an empty list, build the
   * `.section-content` rows, and either return them bare (single populated
   * section under the outer panel) or wrap them in the counted disclosure
   * header via {@link renderSectionDetails}.
   */
  private renderSectionRows<T>(
    items: readonly T[],
    key: (item: T) => unknown,
    renderItem: (item: T, index: number) => TemplateResult,
    withHeader: boolean,
    section: Omit<Parameters<typeof renderSectionDetails>[0], 'content'>,
  ): TemplateResult | typeof nothing {
    if (items.length === 0) return nothing;

    const content = html`
      <div class="section-content">
        ${repeat(items, key, renderItem)}
      </div>
    `;
    if (!withHeader) return content;

    return renderSectionDetails({ ...section, content });
  }

  private renderTaskItem(
    child: ActiveChildInfo,
    index: number,
  ): TemplateResult {
    const icon = getTaskIcon(child);
    // Every roster row owns a stream tab, so every row is navigable; the
    // handlers attach only while a childStreamId is known.
    const childStreamId = child.childStreamId;
    const description = childStreamId
      ? this.streamById.get(childStreamId)?.description
      : undefined;
    const phaseLabel = childStreamId
      ? formatPhaseStageLabel(this.phaseStages.get(childStreamId))
      : undefined;
    const badge = taskStatusBadge(child);
    const idPrefix = `background-subagent-${index}`;
    // RunIdentity is the declared authority; agentName is only a fallback.
    const displayName = child.identity
      ? runIdentityDisplayName(child.identity)
      : child.agentName;

    return html`
      <div class="task-header">
        ${waIcon(icon, {
          className: `task-icon ${child.identity?.kind === 'process' ? 'task-icon--process' : 'task-icon--subagent'}`,
        })}
        <span
          id="${idPrefix}-name"
          class="task-name task-name--clickable"
          role="link"
          tabindex="0"
          @click=${
            childStreamId !== undefined
              ? () => this.navigateToStream(childStreamId)
              : nothing
          }
          @keydown=${
            childStreamId !== undefined
              ? (e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.navigateToStream(childStreamId);
                  }
                }
              : nothing
          }
          >${displayName}</span
        >
        <wa-tooltip for="${idPrefix}-name">Go to ${displayName}</wa-tooltip>
        ${
          phaseLabel
            ? html`<span id="${idPrefix}-phase" class="task-phase"
                  >${phaseLabel}</span
                ><wa-tooltip for="${idPrefix}-phase">${phaseLabel}</wa-tooltip>`
            : nothing
        }
        ${
          description
            ? html`<span id="${idPrefix}-description" class="task-description"
                  >(${description})</span
                ><wa-tooltip for="${idPrefix}-description"
                  >${description}</wa-tooltip
                >`
            : nothing
        }
        ${
          child.elapsed
            ? html`<span class="task-elapsed">(${child.elapsed})</span>`
            : nothing
        }
        <wa-badge
          class="task-status"
          variant=${badge.variant}
          appearance="filled"
          >${badge.text}</wa-badge
        >
      </div>
    `;
  }

  private handleOpenToggle(e: Event): void {
    if (e.target !== e.currentTarget) return;
    this.open = e.type === 'wa-show';
  }

  private navigateToStream(streamId: string): void {
    this.dispatchEvent(ProgressEvents.streamSwitch({ streamId }));
  }
}

/** Nested quiet disclosure wrapping one section's rows, with a counted label. */
function renderSectionDetails(options: {
  icon: TeXRAIconName;
  label: string;
  counts: readonly string[];
  open: boolean;
  content: TemplateResult;
}): TemplateResult {
  return html`
    <wa-details class="collapsible-quiet" ?open=${options.open}>
      <div slot="summary" class="section-label">
        ${waIcon(options.icon)}
        <span
          >${options.label}${options.counts.map(
            (count) => html` &middot; ${count}`,
          )}</span
        >
      </div>
      ${options.content}
    </wa-details>
  `;
}

/** Pick the appropriate wa-icon name for a background task item. */
function getTaskIcon(child: ActiveChildInfo): TeXRAIconName {
  switch (child.identity?.kind) {
    case 'process':
      return 'terminal';
    case 'agent':
      // AI agent rows — native and external-CLI-driven alike.
      return 'robot';
    case 'multiAgentWorkflow':
    case undefined:
      // Workflow containers and legacy emitters without an identity get the
      // neutral agent icon.
      return 'server';
  }
}

/**
 * Badge fill for a stream lifecycle phase. Matches the stream-tab rail/icon
 * palette: green while active, brand/blue while idle, red on failure, and
 * neutral for user stops (and unknown finished rows that must not claim
 * success).
 */
function streamStatusBadgeVariant(
  status: string | undefined,
): 'neutral' | 'brand' | 'success' | 'danger' {
  switch (status) {
    case STREAM_PHASE.RUNNING:
    case STREAM_PHASE.COMPLETED:
      return 'success';
    case STREAM_PHASE.WAITING:
      return 'brand';
    case STREAM_PHASE.FAILED:
      return 'danger';
    case STREAM_PHASE.CANCELLED:
    default:
      return 'neutral';
  }
}

/**
 * Status badge for a background-task row. Wording and color come from the
 * same stream-lifecycle vocabulary as stream tabs / the progress header
 * (`formatStreamStatusLabel` · `progressHeader`), so "Running / Idle /
 * Completed / Stopped / Error" never diverge between the two surfaces.
 *
 * A retained subagent can briefly keep its last in-flight phase while the
 * terminal status catches up; show that phase rather than falsely reporting
 * success. Processes have no child status source, so their retained rows use
 * the terminal fallback below.
 */
function taskStatusBadge(child: ActiveChildInfo): {
  readonly text: string;
  readonly variant: 'neutral' | 'brand' | 'success' | 'danger';
} {
  // Membership is decided by `finishedAt` presence alone (see the schema
  // doc); the lagging display `status` may only soften HOW a retained
  // subagent row renders, and processes have no child status source at all.
  const subagentStatusStillInFlight =
    child.identity?.kind !== 'process' &&
    (child.status === STREAM_PHASE.RUNNING ||
      child.status === STREAM_PHASE.WAITING);
  if (child.finishedAt === undefined || subagentStatusStillInFlight) {
    const status =
      child.status === STREAM_PHASE.WAITING
        ? STREAM_PHASE.WAITING
        : STREAM_PHASE.RUNNING;
    return {
      text: formatStreamStatusLabel(status),
      variant: streamStatusBadgeVariant(status),
    };
  }
  switch (child.status) {
    case STREAM_PHASE.FAILED:
    case STREAM_PHASE.CANCELLED:
    case STREAM_PHASE.COMPLETED:
      return {
        text: formatStreamStatusLabel(child.status),
        variant: streamStatusBadgeVariant(child.status),
      };
    default:
      // Left the roster without a terminal status ever arriving. It did
      // finish, but claiming success would render a failed command green;
      // say only what is known — use the completed word with a neutral fill.
      return {
        text: formatStreamStatusLabel(STREAM_PHASE.COMPLETED),
        variant: 'neutral',
      };
  }
}

function inquiryStatusVariant(
  status: InquiryThreadUpdatedEvent['status'],
): 'warning' | 'success' | 'neutral' {
  if (status === 'open') return 'warning';
  if (status === 'answered') return 'success';
  return 'neutral';
}

declare global {
  interface HTMLElementTagNameMap {
    'background-tasks-panel': BackgroundTasksPanel;
  }
}
