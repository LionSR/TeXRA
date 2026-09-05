/**
 * Headless progress rendering over the session view (PRD
 * one-fold-three-renderers, 10.3): the stderr status line of `texra run`,
 * and the plain-text workflow progress lines. Both read `SessionHandle.view`
 * and derive nothing the fold already states; the renderer keeps only its
 * own output state (what it last wrote).
 */
import path from 'node:path';

import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import { getAgent } from '@agent/index';
import type { SessionHandle } from '@agent/runtime';
import { redactSecrets } from '@logger/redaction';
import { effectRuntime } from '@platform/processRuntime';
import {
  AgentCategory,
  STREAM_PHASE,
  WORKFLOW_TASK_STATUS_LABEL,
  type ExecutionId,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';
import { pluralize } from '@utils/text/stringUtils';

import {
  safeTerminalText,
  textDisplayWidth,
  truncateSummaryToWidth,
} from './terminalText';
import { getStderrColumns, writeRawStderr } from './logSinks';
import type { CliContext } from './cliContext';

const CLEAR_LINE = '\r\x1b[2K';
const ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH = 48;

/** What the renderer reads of a session: its view. */
type RunProgressSession = Pick<SessionHandle, 'view'>;

/** The plain workflow output also subscribes the workflow transcripts it
 *  prints, since transcript rows fold only for subscribed aggregates. */
export type WorkflowPlainSession = Pick<
  SessionHandle,
  'view' | 'setTranscriptSubscriptions'
>;

export interface RunProgressRenderer {
  /** Follow the session's view; `executionId` names the run to describe
   *  (the first root run the view gains after attach, when omitted). */
  attach(
    session: RunProgressSession,
    options?: { readonly executionId?: ExecutionId },
  ): () => void;
  clear(): void;
  preserve(): void;
}

export interface RunProgressRendererInit {
  readonly colorEnabled: boolean;
  readonly write?: (text: string) => void;
  readonly nowMs?: () => number;
  readonly minIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly getColumns?: () => number | undefined;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export function shouldRenderRunProgress(
  context: Pick<CliContext, 'outputFormat' | 'quietLogs'>,
): boolean {
  return !context.quietLogs && context.outputFormat !== 'ndjson';
}

export function createRunProgressRenderer(
  context: CliContext,
  init?: RunProgressRendererInit,
): RunProgressRenderer | undefined {
  if (context.renderRunProgress !== true) return undefined;
  return new DefaultRunProgressRenderer({
    colorEnabled: context.stderrColorEnabled,
    ...init,
    getColumns:
      init?.getColumns ??
      (() => {
        const columns = getStderrColumns();
        return context.stderrIsTty && columns != null && columns > 0
          ? columns
          : undefined;
      }),
  });
}

/** Follow a view level with a callback; returns the detach. */
function followView(
  session: RunProgressSession,
  onView: (view: SessionView) => void,
): () => void {
  const fiber = effectRuntime().runFork(
    Stream.runForEach(SubscriptionRef.changes(session.view), (view) =>
      Effect.sync(() => onView(view)),
    ),
  );
  return () => {
    effectRuntime().runFork(Fiber.interrupt(fiber));
  };
}

class DefaultRunProgressRenderer implements RunProgressRenderer {
  private readonly attachedAt: number;
  private readonly write: (text: string) => void;
  private readonly nowMs: () => number;
  private readonly minIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly setInterval: typeof setInterval;
  private readonly clearInterval: typeof clearInterval;
  private readonly ansi: boolean;
  private readonly getColumns: () => number | undefined;
  private lastRenderAt = 0;
  private lastLine = '';
  private liveLine = false;
  private view: SessionView | undefined;
  private rootStreamId: StreamTabId | undefined;
  private wantedExecutionId: ExecutionId | undefined;
  private attachCursor = 0;
  /** The last root phase the renderer painted; a repeat is not a change. */
  private paintedPhase: StreamPhase | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    init: RunProgressRendererInit & {
      readonly getColumns: () => number | undefined;
    },
  ) {
    this.write = init.write ?? writeRawStderr;
    this.nowMs = init.nowMs ?? Date.now;
    this.minIntervalMs = init.minIntervalMs ?? 100;
    this.heartbeatIntervalMs = init.heartbeatIntervalMs ?? 1000;
    this.setInterval = init.setInterval ?? setInterval;
    this.clearInterval = init.clearInterval ?? clearInterval;
    this.ansi = init.colorEnabled;
    this.getColumns = init.getColumns;
    this.attachedAt = this.nowMs();
  }

  attach(
    session: RunProgressSession,
    options: { readonly executionId?: ExecutionId } = {},
  ): () => void {
    this.wantedExecutionId = options.executionId;
    this.attachCursor = SubscriptionRef.getUnsafe(session.view).cursor;
    const detach = followView(session, (view) => this.applyView(view));
    return () => {
      detach();
      this.view = undefined;
    };
  }

  clear(): void {
    this.stopHeartbeat();
    if (this.ansi && this.liveLine) {
      this.write(CLEAR_LINE);
      this.liveLine = false;
    }
  }

  preserve(): void {
    this.stopHeartbeat();
    if (this.ansi && this.liveLine) {
      this.write('\n');
      this.liveLine = false;
    }
  }

  private root(): StreamView | undefined {
    return this.rootStreamId
      ? this.view?.streams.get(this.rootStreamId)
      : undefined;
  }

  private get rootStreamTerminal(): boolean {
    return isTerminalOutcomePhase(this.root()?.status);
  }

  /**
   * The run this renderer describes: the stream of the named execution, or
   * the first top-level stream created after attach. A child's later
   * appearance never moves it.
   */
  private claimRoot(view: SessionView): void {
    if (this.rootStreamId !== undefined) return;
    const candidates = [...view.streams.values()].filter((stream) =>
      this.wantedExecutionId !== undefined
        ? stream.executionId === this.wantedExecutionId
        : stream.parentId === null && stream.createdAt > this.attachCursor,
    );
    candidates.sort((a, b) => a.createdAt - b.createdAt);
    this.rootStreamId = candidates.at(0)?.id;
  }

  private applyView(view: SessionView): void {
    const previous = this.view;
    this.view = view;
    this.claimRoot(view);
    const root = this.root();
    if (!root) return;
    const wasTerminal = isTerminalOutcomePhase(
      previous && this.rootStreamId
        ? previous.streams.get(this.rootStreamId)?.status
        : undefined,
    );
    const phase = root.status;
    const phaseChanged = phase !== 'ready' && phase !== this.paintedPhase;
    if (phaseChanged) this.paintedPhase = phase;
    // A terminal root freezes the line: the final status is its last paint.
    if (wasTerminal && !phaseChanged) return;
    this.updateHeartbeat();
    this.render(phaseChanged || this.rootStreamTerminal);
  }

  private liveChildren(): readonly StreamView[] {
    const root = this.root();
    if (!root || this.rootStreamTerminal) return [];
    return root.childIds.flatMap((childId) => {
      const child = this.view?.streams.get(childId);
      return child && !isTerminalOutcomePhase(child.status) ? [child] : [];
    });
  }

  private render(force = false): void {
    const now = this.nowMs();
    if (!force && now - this.lastRenderAt < this.minIntervalMs) return;
    const line = this.formatLine(now);
    if (!line || line === this.lastLine) return;
    if (this.ansi) {
      this.write(`${CLEAR_LINE}${line}`);
      this.liveLine = true;
    } else {
      this.write(`${line}\n`);
    }
    this.lastLine = line;
    this.lastRenderAt = now;
  }

  private updateHeartbeat(): void {
    if (this.rootStreamTerminal || !this.rootStreamId) {
      this.stopHeartbeat();
      return;
    }
    if (!this.ansi || this.heartbeatTimer) return;
    this.heartbeatTimer = this.setInterval(() => {
      this.render(true);
    }, this.heartbeatIntervalMs);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    this.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private formatLine(now: number): string {
    const root = this.root();
    if (!root) return '';
    const roundStage = root.stage?.kind === 'round' ? root.stage : undefined;
    const agentName =
      root.identity?.kind === 'agent' ? root.identity.agent : undefined;
    const declaredRounds =
      root.category === AgentCategory.Workflow && agentName !== undefined
        ? getAgent(agentName, AgentCategory.Workflow)?.rounds
        : undefined;
    const plannedRounds = roundStage?.total ?? declaredRounds;
    const parts: string[] = [];
    if (roundStage) {
      parts.push(
        `[${formatRoundStageLabel({
          index: roundStage.index,
          ...(isMultiRound(plannedRounds) ? { total: plannedRounds } : {}),
        })}]`,
      );
    }
    const subject = [agentName, formatInputLabel(root.inputFiles)]
      .filter(Boolean)
      .join(' ');
    const phase = livePhaseText(root);
    parts.push(subject || phase || 'Running');
    if (subject && phase && phase !== 'Running') parts.push(phase);
    if (!roundStage && isMultiRound(plannedRounds)) {
      parts.push(`${plannedRounds} rounds`);
    }
    const runStartedAt = root.runStartedAt ?? this.attachedAt;
    const elapsed = formatElapsed(now - runStartedAt);
    const children = this.liveChildren();
    const nameOnlySubagents = formatActiveChildren(children, 0);
    if (nameOnlySubagents) {
      const descriptionColumns = this.descriptionColumnBudget(
        parts,
        nameOnlySubagents,
        elapsed,
      );
      parts.push(formatActiveChildren(children, descriptionColumns)!);
    }
    const toolCallCount = root.conversationProgress.toolCallCount;
    if (toolCallCount && !nameOnlySubagents) {
      parts.push(`tools: ${toolCallCount}`);
    }
    parts.push(elapsed);
    return parts.join(' · ');
  }

  private descriptionColumnBudget(
    fixedParts: readonly string[],
    nameOnlySubagents: string,
    elapsed: string,
  ): number {
    const columns = normalizeTerminalColumns(this.getColumns());
    if (!this.ansi || columns == null) {
      return ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH;
    }
    const lineWithoutDescription = [
      ...fixedParts,
      nameOnlySubagents,
      elapsed,
    ].join(' · ');
    return Math.min(
      ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH,
      Math.max(
        0,
        columns -
          textDisplayWidth(lineWithoutDescription) -
          textDisplayWidth(' — '),
      ),
    );
  }
}

/** The fold's label (G4, one table) for every state but a running run,
 *  whose live task is its description once the AI one-liner has arrived. */
function livePhaseText(root: StreamView): string | undefined {
  if (root.status === 'ready') return undefined;
  if (root.status === STREAM_PHASE.RUNNING) {
    return root.description ?? root.statusLabel;
  }
  return root.statusLabel;
}

function formatInputLabel(files: readonly string[]): string | undefined {
  const first = files.at(0);
  if (!first) return undefined;
  const firstName = path.basename(first);
  return files.length === 1 ? firstName : `${firstName} +${files.length - 1}`;
}

/** The named agent children (a process child has no agent to name). */
function formatActiveChildren(
  children: readonly StreamView[],
  descriptionColumns: number,
): string | undefined {
  const agents = children.filter((child) => child.identity?.kind === 'agent');
  const first =
    agents.find((child) => child.status === STREAM_PHASE.RUNNING) ?? agents[0];
  if (!first) return undefined;
  const label = pluralize(agents.length, 'subagent');
  const suffix = agents.length > 1 ? ` +${agents.length - 1}` : '';
  const description = first.description;
  const safeDescription =
    description && descriptionColumns > 0
      ? truncateSummaryToWidth(
          redactSecrets(safeTerminalText(description)),
          descriptionColumns,
        )
      : '';
  const task = safeDescription ? ` — ${safeDescription}` : '';
  return `${label}: ${first.label}${task}${suffix}`;
}

function normalizeTerminalColumns(
  columns: number | undefined,
): number | undefined {
  if (columns == null || !Number.isFinite(columns)) return undefined;
  return Math.max(0, Math.floor(columns));
}

function isMultiRound(rounds: number | undefined): rounds is number {
  return rounds != null && rounds > 1;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Plain-text workflow progress
// ---------------------------------------------------------------------------

interface WorkflowPlainOutputOptions {
  readonly writeLine: (line: string) => void;
  readonly beforeWrite?: () => void;
}

/** The lines one workflow-script stream's view level says: phase headings,
 *  task lines, log lines, and its outcome, keyed by the row they come from. */
function workflowPlainLines(stream: StreamView): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  const run = stream.transcript.run;
  for (const phase of run?.phases ?? []) {
    if (phase.opened) {
      lines.set(
        `phase:${phase.key}`,
        `◆ ${formatWorkflowPhaseHeading(phase.heading)}`,
      );
    }
  }
  for (const row of stream.transcript.rows) {
    if (row.kind === 'workflowTask') {
      lines.set(row.id, row.line);
    } else if (
      row.kind === 'log' &&
      row.level !== 'debug' &&
      row.verbose !== false &&
      row.text.full.trim().length > 0
    ) {
      lines.set(row.id, row.text.full);
    }
  }
  if (
    isTerminalOutcomePhase(stream.status) &&
    stream.identity?.kind === 'multiAgentWorkflow'
  ) {
    lines.set(
      'outcome',
      `${WORKFLOW_TASK_STATUS_LABEL[stream.status]}: ${stream.identity.workflowName}`,
    );
  }
  return lines;
}

/**
 * The plain-text workflow progress of `texra run` (text output): what
 * `transcript.run` and the stream's rows say, printed as they change
 * between consecutive view levels (PRD 10.3). A line prints when its entry
 * is new or reads differently than at the previous level; nothing here
 * folds, gates, or relabels.
 */
export function attachWorkflowPlainOutput(
  session: WorkflowPlainSession,
  options: WorkflowPlainOutputOptions,
): () => void {
  const previous = new Map<StreamTabId, ReadonlyMap<string, string>>();
  let subscribed = '';
  const write = (line: string): void => {
    options.beforeWrite?.();
    options.writeLine(line);
  };
  const printStream = (stream: StreamView): void => {
    const before = previous.get(stream.id);
    const lines = workflowPlainLines(stream);
    previous.set(stream.id, lines);
    for (const [id, line] of lines) {
      if (before?.get(id) !== line) write(line);
    }
  };
  const detach = followView(session, (view) => {
    for (const streamId of [...previous.keys()]) {
      if (!view.streams.has(streamId)) previous.delete(streamId);
    }
    const workflows = [...view.streams.values()].filter(
      (stream) => stream.identity?.kind === 'multiAgentWorkflow',
    );
    const key = workflows.map((stream) => stream.id).join('\0');
    if (key !== subscribed) {
      subscribed = key;
      session.setTranscriptSubscriptions(
        'workflow-plain-output',
        workflows.map((stream) => ({ id: stream.id, fromSeq: 0 })),
      );
    }
    for (const stream of workflows) printStream(stream);
  });
  return () => {
    detach();
    previous.clear();
    session.setTranscriptSubscriptions('workflow-plain-output', []);
  };
}
