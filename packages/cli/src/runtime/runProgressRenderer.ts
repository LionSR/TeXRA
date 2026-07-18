import path from 'node:path';

// Local imports - agent runtime and trace
import { getAgent } from '@agent/index';
import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type {
  SessionEvent,
  SessionEventHub,
  SessionFact,
} from '@agent/runtime/SessionEventHub';

// Local imports - shared schemas
import {
  STREAM_PHASE,
  type ActiveChildInfo,
  type ConversationProgress,
  type RoundStage,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import { assertNever } from '@utils/core';
import { pluralize } from '@utils/text/stringUtils';

// Local imports - CLI runtime
import { writeRawStderr } from './logSinks';
import type { CliContext } from './cliContext';

const RUN_PROGRESS_RUN_FACT_TYPES = [
  'conversation.progress',
  'run.config',
  'status',
  'stage.start',
  'child.activity',
] as const satisfies readonly AgentEvent['type'][];

// Carriage return + erase-line (CSI 2K): rewind to column 0 and clear the row
// so the single live status line can be repainted in place.
const CLEAR_LINE = '\r\x1b[2K';

interface RenderState {
  round?: number;
  plannedRounds?: number;
  toolCallCount?: number;
  agent?: string;
  inputLabel?: string;
  phase?: string;
  activeProcesses?: string;
  activeSubagents?: string;
}

export interface RunProgressRenderer {
  handleSessionEvent(event: SessionEvent): boolean;
  clear(): void;
  preserve(): void;
}

export interface RunProgressRendererInit {
  readonly colorEnabled: boolean;
  readonly write?: (text: string) => void;
  readonly nowMs?: () => number;
  readonly minIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
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
  init: RunProgressRendererInit = {
    colorEnabled: context.stderrColorEnabled,
  },
): RunProgressRenderer | undefined {
  if (context.renderRunProgress !== true) return undefined;
  return new DefaultRunProgressRenderer(init);
}

export function attachRunProgressRenderer(
  events: SessionEventHub,
  renderer: RunProgressRenderer | undefined,
): () => void {
  if (!renderer) return () => undefined;

  const detachSessionFacts = events.subscribe(
    (event) => {
      renderer.handleSessionEvent(event);
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (event) => {
      renderer.handleSessionEvent(event);
    },
    { scope: 'run', types: RUN_PROGRESS_RUN_FACT_TYPES },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}

class DefaultRunProgressRenderer implements RunProgressRenderer {
  private readonly state: RenderState = {};
  private readonly startedAt: number;
  private readonly write: (text: string) => void;
  private readonly nowMs: () => number;
  private readonly minIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly setInterval: typeof setInterval;
  private readonly clearInterval: typeof clearInterval;
  private readonly ansi: boolean;
  private lastRenderAt = 0;
  private lastLine = '';
  private liveLine = false;
  private rootStreamId: StreamTabId | undefined;
  private rootStreamStatus: StreamPhase | undefined;
  private rootStreamTerminal = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(init: RunProgressRendererInit) {
    this.write = init.write ?? writeRawStderr;
    this.nowMs = init.nowMs ?? Date.now;
    this.minIntervalMs = init.minIntervalMs ?? 100;
    this.heartbeatIntervalMs = init.heartbeatIntervalMs ?? 1000;
    this.setInterval = init.setInterval ?? setInterval;
    this.clearInterval = init.clearInterval ?? clearInterval;
    this.ansi = init.colorEnabled;
    this.startedAt = this.nowMs();
  }

  handleSessionEvent(event: SessionEvent): boolean {
    if (event.scope === 'session') {
      return this.handleSessionFact(event.event);
    }
    return this.handleRunFact(event.streamId, event.event);
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

  private handleSessionFact(event: SessionFact): boolean {
    switch (event.type) {
      case 'updateStreamStatus': {
        const { status, streamId } = event.payload;
        this.applyStatus(streamId, status);
        return true;
      }
      case 'updateStreamDescription':
        if (!this.rootStreamTerminal) {
          this.applyStreamDescription(
            event.payload.streamId,
            event.payload.description,
          );
        }
        return true;
      case 'goalStateChanged':
      case 'inquiryThreadUpdated':
      case 'clearMissingOutputs':
      case 'updateQueuedFollowUps':
      case 'followUpSent':
      case 'setActiveStream':
      case 'setParentStream':
      case 'removeStream':
        return false;
    }
    return assertNever(event, 'Unhandled run-progress renderer session fact');
  }

  private handleRunFact(streamId: StreamTabId, event: AgentEvent): boolean {
    switch (event.type) {
      case 'run.config':
        if (this.applyRunConfig(event.streamId, event.config)) {
          this.updateHeartbeat();
          this.render(true);
        }
        return true;
      case 'status':
        this.applyStatus(event.streamId, event.phase);
        return true;
      case 'conversation.progress':
        if (this.rootStreamTerminal) return true;
        if (this.applyConversationProgress(streamId, event.progress)) {
          this.updateHeartbeat();
          this.render();
        }
        return true;
      case 'stage.start':
        if (this.rootStreamTerminal || event.kind !== 'round') return true;
        if (
          this.applyRoundStage(streamId, {
            index: event.index ?? 0,
            ...(event.total !== undefined && event.total > 0
              ? { total: event.total }
              : {}),
          })
        ) {
          this.updateHeartbeat();
          this.render();
        }
        return true;
      case 'child.activity':
        if (this.rootStreamTerminal) return true;
        if (event.kind === 'processes') {
          this.applyActiveProcesses(event.parentStreamId, event.items);
        } else {
          this.applyActiveSubagents(event.parentStreamId, event.items);
        }
        this.updateHeartbeat();
        this.render(true);
        return true;
      default:
        return false;
    }
  }

  private applyRunConfig(streamId: StreamTabId, config: AgentConfig): boolean {
    if (!this.claimRootStream(streamId)) return false;

    this.state.agent = config.agent;
    this.state.inputLabel = formatInputLabel(config.inputFiles);
    this.state.plannedRounds =
      config.agentCategory === AgentCategory.Workflow
        ? getAgent(config.agent, AgentCategory.Workflow)?.rounds
        : undefined;
    this.state.phase ??= 'running';
    return true;
  }

  private applyConversationProgress(
    streamId: StreamTabId,
    progress: ConversationProgress,
  ): boolean {
    if (!this.claimRootStream(streamId)) return false;

    this.state.toolCallCount = progress.toolCallCount || undefined;
    this.state.phase ??= 'running';
    return true;
  }

  private applyRoundStage(
    streamId: StreamTabId,
    roundStage: RoundStage,
  ): boolean {
    if (!this.claimRootStream(streamId)) return false;

    this.state.round = roundStage.index + 1;
    if (roundStage.total !== undefined) {
      this.state.plannedRounds = roundStage.total;
    }
    this.state.phase ??= 'running';
    return true;
  }

  private applyActiveProcesses(
    parentStreamId: StreamTabId,
    processes: readonly ActiveChildInfo[],
  ): void {
    if (!this.claimRootStream(parentStreamId)) return;

    this.state.activeProcesses = formatActiveChildren(
      'tool',
      processes.map(
        (activeProcess) => activeProcess.toolName ?? activeProcess.agentName,
      ),
    );
  }

  private applyActiveSubagents(
    parentStreamId: StreamTabId,
    children: readonly ActiveChildInfo[],
  ): void {
    if (!this.claimRootStream(parentStreamId)) return;

    this.state.activeSubagents = formatActiveChildren(
      'subagent',
      children.map((child) => child.agentName),
    );
  }

  private applyStatus(streamId: StreamTabId, status: StreamPhase): void {
    if (!this.isRootStream(streamId)) return;
    if (this.rootStreamStatus === status) return;

    this.rootStreamStatus = status;
    this.state.phase = formatRunProgressStatus(status);
    this.rootStreamTerminal = isTerminalOutcomePhase(status);
    if (this.rootStreamTerminal) {
      this.state.activeProcesses = undefined;
      this.state.activeSubagents = undefined;
    }
    this.updateHeartbeat();
    this.render(true);
  }

  private applyStreamDescription(
    streamId: StreamTabId,
    description: string,
  ): void {
    if (!this.isRootStream(streamId)) return;

    this.state.phase = description;
    this.updateHeartbeat();
    this.render(true);
  }

  private claimRootStream(streamId: StreamTabId): boolean {
    this.rootStreamId ??= streamId;
    return this.rootStreamId === streamId;
  }

  private isRootStream(streamId: StreamTabId): boolean {
    return this.rootStreamId === streamId;
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
    const parts: string[] = [];
    if (this.state.round != null) {
      parts.push(
        formatRoundProgress(this.state.round, this.state.plannedRounds),
      );
    }

    const subject = [this.state.agent, this.state.inputLabel]
      .filter(Boolean)
      .join(' ');
    const phase = this.state.phase;
    parts.push(subject || phase || 'running');
    if (subject && phase && phase !== 'running') parts.push(phase);
    if (this.state.round == null && isMultiRound(this.state.plannedRounds)) {
      parts.push(`${this.state.plannedRounds} rounds`);
    }

    if (this.state.activeSubagents) parts.push(this.state.activeSubagents);
    if (this.state.activeProcesses) parts.push(this.state.activeProcesses);
    if (
      this.state.toolCallCount != null &&
      !this.state.activeSubagents &&
      !this.state.activeProcesses
    ) {
      parts.push(`tools: ${this.state.toolCallCount}`);
    }
    parts.push(formatElapsed(now - this.startedAt));
    return parts.join(' · ');
  }
}

function formatRunProgressStatus(status: StreamPhase): string {
  if (status === STREAM_PHASE.COMPLETED) return 'done';
  if (status === STREAM_PHASE.CANCELLED) return 'interrupted';
  if (status === STREAM_PHASE.FAILED) return 'error';
  return status;
}

function formatInputLabel(files: readonly string[]): string | undefined {
  const first = files.at(0);
  if (!first) return undefined;

  const firstName = path.basename(first);
  return files.length === 1 ? firstName : `${firstName} +${files.length - 1}`;
}

function formatActiveChildren(
  kind: 'subagent' | 'tool',
  names: readonly (string | undefined)[],
): string | undefined {
  const namedChildren = names.filter((name): name is string => Boolean(name));
  const first = namedChildren[0];
  if (!first) return undefined;

  const label = pluralize(namedChildren.length, kind);
  const suffix =
    namedChildren.length > 1 ? ` +${namedChildren.length - 1}` : '';
  return `${label}: ${first}${suffix}`;
}

function formatRoundProgress(
  round: number,
  plannedRounds: number | undefined,
): string {
  if (isMultiRound(plannedRounds) && round <= plannedRounds) {
    return `[r${round}/${plannedRounds}]`;
  }
  return `[r${round}]`;
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
