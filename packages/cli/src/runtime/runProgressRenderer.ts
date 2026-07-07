import path from 'node:path';

// Local imports - agent metadata
import { getAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';

// Local imports - progress events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventContract';

// Local imports - shared schemas
import { STREAM_PHASE, STREAM_STATUS, type StreamPhase } from '@shared/schemas';

// Local imports - CLI runtime
import { writeRawStderr } from './logSinks';
import type { CliContext } from './cliContext';

type ProgressEvent = keyof ProgressEventPayloads;

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
  handle(event: ProgressEvent, payload: unknown): boolean;
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
  return context.quietLogs !== true && context.outputFormat !== 'ndjson';
}

export function createRunProgressRenderer(
  context: CliContext,
  init: RunProgressRendererInit = { colorEnabled: context.colorEnabled },
): RunProgressRenderer | undefined {
  if (context.renderRunProgress !== true) return undefined;
  return new DefaultRunProgressRenderer(init);
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
  private rootStreamId: string | undefined;
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

  handle(event: ProgressEvent, payload: unknown): boolean {
    switch (event) {
      case 'setTaskState':
        if (
          this.applyTaskState(payload as ProgressEventPayloads['setTaskState'])
        ) {
          this.updateHeartbeat();
          this.render(true);
        }
        return true;
      case 'updateConversationProgress':
        if (this.rootStreamTerminal) return true;
        if (
          this.applyConversationProgress(
            payload as ProgressEventPayloads['updateConversationProgress'],
          )
        ) {
          this.updateHeartbeat();
          this.render();
        }
        return true;
      case 'updateRoundStage':
        if (this.rootStreamTerminal) return true;
        if (
          this.applyRoundStage(
            payload as ProgressEventPayloads['updateRoundStage'],
          )
        ) {
          this.updateHeartbeat();
          this.render();
        }
        return true;
      case 'updateActiveProcesses':
      case 'updateActiveSubagents':
        if (this.rootStreamTerminal) return true;
        if (event === 'updateActiveProcesses') {
          this.applyActiveProcesses(
            payload as ProgressEventPayloads['updateActiveProcesses'],
          );
        } else {
          this.applyActiveSubagents(
            payload as ProgressEventPayloads['updateActiveSubagents'],
          );
        }
        this.updateHeartbeat();
        this.render(true);
        return true;
      case 'updateStreamStatus':
        {
          const data = payload as ProgressEventPayloads['updateStreamStatus'];
          if (!this.isRootStream(data.streamId)) return true;
          const { status } = data;
          this.state.phase = formatRunProgressStatus(status);
          this.rootStreamTerminal = isTerminalStreamStatus(status);
          if (this.rootStreamTerminal) {
            this.state.activeProcesses = undefined;
            this.state.activeSubagents = undefined;
          }
          this.updateHeartbeat();
          this.render(true);
        }
        return true;
      case 'updateStreamDescription': {
        if (this.rootStreamTerminal) return true;
        const data =
          payload as ProgressEventPayloads['updateStreamDescription'];
        if (this.isRootStream(data.streamId)) {
          this.state.phase = data.description;
          this.updateHeartbeat();
          this.render(true);
        }
        return true;
      }
      default:
        return false;
    }
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

  private applyTaskState(
    payload: ProgressEventPayloads['setTaskState'],
  ): boolean {
    if (!this.claimRootStream(payload.streamId)) return false;

    const config = payload.taskState.agentConfig;
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
    payload: ProgressEventPayloads['updateConversationProgress'],
  ): boolean {
    if (!this.claimRootStream(payload.streamId)) return false;

    this.state.toolCallCount = payload.progress.toolCallCount || undefined;
    this.state.phase ??= 'running';
    return true;
  }

  private applyRoundStage(
    payload: ProgressEventPayloads['updateRoundStage'],
  ): boolean {
    if (!this.claimRootStream(payload.streamId)) return false;

    this.state.round = payload.roundStage.index + 1;
    if (payload.roundStage.total !== undefined) {
      this.state.plannedRounds = payload.roundStage.total;
    }
    this.state.phase ??= 'running';
    return true;
  }

  private applyActiveProcesses(
    payload: ProgressEventPayloads['updateActiveProcesses'],
  ): void {
    if (!this.claimRootStream(payload.parentStreamId)) return;

    this.state.activeProcesses = formatActiveChildren(
      'tool',
      payload.processes.map(
        (activeProcess) => activeProcess.toolName ?? activeProcess.agentName,
      ),
    );
  }

  private applyActiveSubagents(
    payload: ProgressEventPayloads['updateActiveSubagents'],
  ): void {
    if (!this.claimRootStream(payload.parentStreamId)) return;

    this.state.activeSubagents = formatActiveChildren(
      'subagent',
      payload.children.map((child) => child.agentName),
    );
  }

  private claimRootStream(streamId: string): boolean {
    this.rootStreamId ??= streamId;
    return this.rootStreamId === streamId;
  }

  private isRootStream(streamId: string): boolean {
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

function isTerminalStreamStatus(status: StreamPhase): boolean {
  return (
    status === STREAM_PHASE.COMPLETED ||
    status === STREAM_PHASE.CANCELLED ||
    status === STREAM_PHASE.FAILED
  );
}

function formatRunProgressStatus(status: StreamPhase): string {
  if (status === STREAM_PHASE.COMPLETED) return 'done';
  if (status === STREAM_PHASE.CANCELLED) return 'interrupted';
  if (status === STREAM_PHASE.FAILED) return STREAM_STATUS.ERROR;
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

  const plural = kind === 'tool' ? 'tools' : 'subagents';
  const label = namedChildren.length === 1 ? kind : plural;
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
