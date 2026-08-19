// Node imports
import path from 'node:path';

// Local imports
import { getAgent } from '@agent/index';
import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { AgentConfig, SessionHandle } from '@agent/runtime';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type {
  PresentedStreamId,
  SessionRendererPort,
  SessionRenderSlice,
} from '@controllers/session/SessionRendererPort';
import { SessionState } from '@controllers/session/SessionState';
import { redactSecrets } from '@logger/redaction';
import type {
  ActiveChildInfo,
  ConversationProgress,
  GoalStatus,
  InquiryThreadUpdatedEvent,
  Plan,
  StreamPhase,
  StreamStage,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { AgentCategory, STREAM_PHASE } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import {
  safeTerminalText,
  textDisplayWidth,
  truncateSummaryToWidth,
} from './terminalText';
import { getStderrColumns, writeRawStderr } from './logSinks';
import type { CliContext } from './cliContext';

// Carriage return + erase-line (CSI 2K): rewind to column 0 and clear the row
// so the single live status line can be repainted in place.
const CLEAR_LINE = '\r\x1b[2K';
const ACTIVE_CHILD_DESCRIPTION_MAX_LENGTH = 48;

export interface RunProgressRenderer {
  /**
   * Fold this session's facts into the shared `SessionState` and repaint from
   * it. Returns the detach handle.
   */
  attach(session: SessionHandle): () => void;
  clear(): void;
  preserve(): void;
}

export interface RunProgressRendererInit {
  readonly colorEnabled: boolean;
  readonly write?: (text: string) => void;
  readonly nowMs?: () => number;
  readonly minIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  /** Width of the stderr terminal used for the repainting live line. */
  readonly columns?: number;
  /** Supplies the current stderr width, allowing live terminal resizes. */
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
    getColumns:
      init?.getColumns ??
      (init?.columns === undefined
        ? () => {
            const columns = getStderrColumns();
            return context.stderrIsTty && columns != null && columns > 0
              ? columns
              : undefined;
          }
        : () => init.columns),
    ...init,
  });
}

export function attachRunProgressRenderer(
  session: SessionHandle,
  renderer: RunProgressRenderer | undefined,
): () => void {
  return renderer ? renderer.attach(session) : () => undefined;
}

/**
 * Everything the live line needs that no shared record carries: the run's
 * `AgentConfig` never lands on `SessionState` (the summary mirror keeps only
 * model / working directory / command), so the agent name, the input-file
 * label and the workflow's declared round count are read from the fact and
 * held here. Round index, tool calls, child roster and child descriptions all
 * come from `SessionState` at paint time instead.
 */
interface RootRunConfigState {
  plannedRounds?: number;
  agent?: string;
  inputLabel?: string;
}

class DefaultRunProgressRenderer implements RunProgressRenderer {
  private readonly config: RootRunConfigState = {};
  private readonly startedAt: number;
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
  private state: SessionState | undefined;
  private rootStreamId: StreamTabId | undefined;
  private rootStreamStatus: StreamPhase | undefined;
  /**
   * Last-write-wins subject line for the root stream: a status transition
   * writes its label, a description fact replaces it with the run's own
   * one-liner, and the next transition takes it back. Ordering is the whole
   * semantic, so it stays a written field rather than a read of the two
   * shared sources.
   */
  private rootPhaseText: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  /** Derived from the one status field, never mirrored into a second flag. */
  private get rootStreamTerminal(): boolean {
    return isTerminalOutcomePhase(this.rootStreamStatus);
  }

  constructor(init: RunProgressRendererInit) {
    this.write = init.write ?? writeRawStderr;
    this.nowMs = init.nowMs ?? Date.now;
    this.minIntervalMs = init.minIntervalMs ?? 100;
    this.heartbeatIntervalMs = init.heartbeatIntervalMs ?? 1000;
    this.setInterval = init.setInterval ?? setInterval;
    this.clearInterval = init.clearInterval ?? clearInterval;
    this.ansi = init.colorEnabled;
    this.getColumns = init.getColumns ?? (() => init.columns);
    this.startedAt = this.nowMs();
  }

  attach(session: SessionHandle): () => void {
    const state = new SessionState(session);
    this.state = state;
    const applier = new SessionFactApplier(state, new HeadlessPort(this), {
      // Headless owns no durable deletion: reporting nothing keeps the
      // removal barrier, which is exactly what the live line wants — a
      // removed child drops out of the roster it reads.
      deleteStream: () => undefined,
    });
    const detachSessionFacts = session.events.subscribeSessionFacts((fact) =>
      applier.handleSessionFact(fact),
    );
    const detachRunFacts = session.events.subscribeRunFacts(
      (runFact) => {
        // The run's `AgentConfig` is the one payload the shared state does not
        // retain; take it before handing the fact to the applier.
        if (runFact.event.type === 'run.config') {
          this.applyRunConfig(runFact.event.streamId, runFact.event.config);
        }
        applier.handleRunFact(runFact.streamId, runFact.event);
      },
      { types: RUN_FACT_EVENT_TYPES },
    );
    return () => {
      detachRunFacts();
      detachSessionFacts();
      applier.dispose();
      this.state = undefined;
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

  /**
   * Repaint after a fact the applier has already landed on `SessionState`.
   * The first stream to report progress claims the root slot, exactly as the
   * first `run.config` does — a headless run renders one stream's line.
   */
  refreshFor(streamId: StreamTabId, force = false): void {
    if (!this.claimRootStream(streamId) || this.rootStreamTerminal) return;
    this.updateHeartbeat();
    this.render(force);
  }

  applyStatus(streamId: StreamTabId, status: StreamPhase | undefined): void {
    if (status === undefined || !this.isRootStream(streamId)) return;
    if (this.rootStreamStatus === status) return;

    this.rootStreamStatus = status;
    this.rootPhaseText = formatStreamStatusLabel(status, { style: 'cli' });
    this.updateHeartbeat();
    this.render(true);
  }

  applyStreamDescription(streamId: StreamTabId, description: string): void {
    if (this.rootStreamTerminal) return;
    if (this.isRootStream(streamId)) {
      this.rootPhaseText = description;
    } else if (
      !this.liveChildren().some((child) => child.childStreamId === streamId)
    ) {
      // A stream the live line does not name has nothing to repaint for.
      return;
    }
    this.updateHeartbeat();
    this.render(true);
  }

  private applyRunConfig(streamId: StreamTabId, config: AgentConfig): void {
    if (!this.claimRootStream(streamId)) return;

    this.config.agent = config.agent;
    this.config.inputLabel = formatInputLabel(config.inputFiles);
    this.config.plannedRounds =
      config.agentCategory === AgentCategory.Workflow
        ? getAgent(config.agent, AgentCategory.Workflow)?.rounds
        : undefined;
    this.rootPhaseText ??= 'running';
    this.updateHeartbeat();
    this.render(true);
  }

  private claimRootStream(streamId: StreamTabId): boolean {
    this.rootStreamId ??= streamId;
    return this.rootStreamId === streamId;
  }

  isRootStream(streamId: StreamTabId): boolean {
    return this.rootStreamId === streamId;
  }

  /** Live (not yet retired) children of the root run, from the shared roster. */
  private liveChildren(): readonly ActiveChildInfo[] {
    if (this.rootStreamTerminal || !this.rootStreamId) return [];
    const roster = this.state?.getStreamState(this.rootStreamId)?.subagents;
    return roster?.filter((child) => child.finishedAt === undefined) ?? [];
  }

  private childDescription(streamId: StreamTabId): string | undefined {
    return this.state?.getStreamMetadata(streamId).description;
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
    const rootStreamId = this.rootStreamId;
    const execution = rootStreamId
      ? this.state?.getStreamState(rootStreamId)
      : undefined;
    const roundStage =
      execution?.stage?.kind === 'round' ? execution.stage : undefined;
    const plannedRounds = roundStage?.total ?? this.config.plannedRounds;

    const parts: string[] = [];
    if (roundStage) {
      parts.push(
        `[${formatRoundStageLabel({
          index: roundStage.index,
          ...(isMultiRound(plannedRounds) ? { total: plannedRounds } : {}),
        })}]`,
      );
    }

    const subject = [this.config.agent, this.config.inputLabel]
      .filter(Boolean)
      .join(' ');
    const phase = this.rootPhaseText;
    parts.push(subject || phase || 'running');
    if (subject && phase && phase !== 'running') parts.push(phase);
    if (!roundStage && isMultiRound(plannedRounds)) {
      parts.push(`${plannedRounds} rounds`);
    }

    const elapsed = formatElapsed(now - this.startedAt);
    const children = this.liveChildren();
    const describe = (child: ActiveChildInfo): string | undefined =>
      this.childDescription(child.childStreamId);
    const nameOnlySubagents = formatActiveChildren(children, describe, 0);
    if (nameOnlySubagents) {
      const descriptionColumns = this.descriptionColumnBudget(
        parts,
        nameOnlySubagents,
        elapsed,
      );
      parts.push(formatActiveChildren(children, describe, descriptionColumns)!);
    }
    const toolCallCount = execution?.conversationProgress.toolCallCount;
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

/**
 * The headless host's `SessionRendererPort`. Every fact is already folded into
 * `SessionState` by the time these fire, so each one only decides whether the
 * single live stderr line is worth repainting — the two exceptions are the
 * root stream's phase and description, which are last-write-wins ordering the
 * shared record does not encode.
 */
class HeadlessPort implements SessionRendererPort {
  constructor(private readonly renderer: DefaultRunProgressRenderer) {}

  isAvailable(): boolean {
    return true;
  }

  dispose(): void {}

  invalidate(_streamId: StreamTabId, _slice: SessionRenderSlice): void {}

  onStreamMetadataChanged(
    streamId: StreamTabId,
    options?: Parameters<SessionRendererPort['onStreamMetadataChanged']>[1],
  ): void {
    // A new stream and a new RUNNING transition report their phase here
    // instead of through `onStreamStatusChanged`.
    this.renderer.applyStatus(
      streamId,
      options?.streamStates?.get(streamId)?.phase,
    );
  }

  onStreamStatusChanged(streamId: StreamTabId, status: StreamPhase): void {
    this.renderer.applyStatus(streamId, status);
  }

  onActiveStreamChanged(_streamId: PresentedStreamId): void {}

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void {
    this.renderer.applyStreamDescription(streamId, description);
  }

  onConversationProgressChanged(
    streamId: StreamTabId,
    _progress: ConversationProgress,
  ): void {
    this.renderer.refreshFor(streamId);
  }

  onStageChanged(streamId: StreamTabId, _stage: StreamStage): void {
    this.renderer.refreshFor(streamId);
  }

  onBadgesChanged(streamId: StreamTabId): void {
    this.renderer.refreshFor(streamId, true);
  }

  onMissingOutputsChanged(_streamId: StreamTabId): void {}

  onRunUsageChanged(
    _streamId: StreamTabId,
    _storageKey: string,
    _usage: TokenUsageStats,
  ): void {}

  onTodosChanged(_streamId: StreamTabId, _todos: TodoItem[]): void {}

  onPlanChanged(_streamId: StreamTabId, _plan: Plan | null): void {}

  onInquiryThreadUpdated(_thread: InquiryThreadUpdatedEvent): void {}

  onGoalActiveChanged(
    _streamId: StreamTabId,
    _active: boolean,
    _details?: { status?: GoalStatus; objective?: string },
  ): void {}

  clearPendingConversationProgress(_streamId: StreamTabId): void {}

  syncStreamContent(
    _stream: PresentedStreamId,
    _options?: { includeActiveState?: boolean },
  ): void {}
}

function formatInputLabel(files: readonly string[]): string | undefined {
  const first = files.at(0);
  if (!first) return undefined;

  const firstName = path.basename(first);
  return files.length === 1 ? firstName : `${firstName} +${files.length - 1}`;
}

function formatActiveChildren(
  children: readonly ActiveChildInfo[],
  describe: (child: ActiveChildInfo) => string | undefined,
  descriptionColumns: number,
): string | undefined {
  const namedChildren = children.filter((child) => child.agentName.length > 0);
  const first =
    namedChildren.find((child) => child.status === STREAM_PHASE.RUNNING) ??
    namedChildren[0];
  if (!first) return undefined;

  const label = pluralize(namedChildren.length, 'subagent');
  const suffix =
    namedChildren.length > 1 ? ` +${namedChildren.length - 1}` : '';
  const description = describe(first);
  const safeDescription =
    description && descriptionColumns > 0
      ? truncateSummaryToWidth(
          redactSecrets(safeTerminalText(description)),
          descriptionColumns,
        )
      : '';
  const task = safeDescription ? ` — ${safeDescription}` : '';
  return `${label}: ${first.agentName}${task}${suffix}`;
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

// Deliberately stays in minute-second form past 60 minutes (`100m 00s`, not
// `1h 40m`) — unlike `formatCompactDuration`, which rounds to a compact
// two-unit display. A long-running task should keep showing precise elapsed
// minutes rather than snapping to hour granularity.
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
}
