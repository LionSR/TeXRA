// Node imports
import path from 'node:path';

// Local imports
import { getAgent } from '@agent/index';
import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  SessionEvent,
  SessionEventHub,
  SessionFact,
} from '@agent/runtime/SessionEventHub';
import type {
  ActiveChildInfo,
  ConversationProgress,
  RoundStage,
  StreamPhase,
  StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { roundStageFromStageStart } from '@shared/streams/stage';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import {
  formatRoundStageLabel,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';
import { assertNever } from '@utils/core';
import { pluralize } from '@utils/text/stringUtils';

// Local file imports
import { writeRawStderr } from './logSinks';
import type { CliContext } from './cliContext';

const RUN_PROGRESS_RUN_FACT_TYPES = [
  'conversation.progress',
  'run.config',
  'stage.start',
  'child.activity',
] as const satisfies readonly AgentEvent['type'][];

/** The run-fact vocabulary this renderer's subscription filter admits. */
type RunProgressRunFactEvent = Extract<
  AgentEvent,
  { type: (typeof RUN_PROGRESS_RUN_FACT_TYPES)[number] }
>;

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
  activeSubagents?: string;
}

export interface RunProgressRenderer {
  /**
   * Takes session facts and the run facts named by
   * `RUN_PROGRESS_RUN_FACT_TYPES` only; any other run fact is out of contract
   * and throws rather than being dropped.
   */
  handleSessionEvent(event: SessionEvent): void;
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

  const handleEvent = (event: SessionEvent): void =>
    renderer.handleSessionEvent(event);
  const detachSessionFacts = events.subscribe(handleEvent, {
    scope: 'session',
  });
  const detachRunFacts = events.subscribe(handleEvent, {
    scope: 'run',
    types: RUN_PROGRESS_RUN_FACT_TYPES,
  });

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
    this.startedAt = this.nowMs();
  }

  handleSessionEvent(event: SessionEvent): void {
    if (event.scope === 'session') {
      this.handleSessionFact(event.event);
      return;
    }
    // Narrowed by `attachRunProgressRenderer`'s filter, which admits only
    // `RUN_PROGRESS_RUN_FACT_TYPES`.
    this.handleRunFact(event.streamId, event.event as RunProgressRunFactEvent);
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

  private handleSessionFact(event: SessionFact): void {
    switch (event.type) {
      case 'status':
        this.applyStatus(event.streamId, event.phase);
        return;
      case 'updateStreamDescription':
        if (!this.rootStreamTerminal) {
          this.applyStreamDescription(
            event.payload.streamId,
            event.payload.description,
          );
        }
        return;
      case 'goalStateChanged':
      case 'inquiryThreadUpdated':
      case 'clearMissingOutputs':
      case 'updateQueuedFollowUps':
      case 'followUpSent':
      case 'setActiveStream':
      case 'setParentStream':
      case 'removeStream':
        return;
    }
    assertNever(event, 'Unhandled run-progress renderer session fact');
  }

  private handleRunFact(
    streamId: StreamTabId,
    event: RunProgressRunFactEvent,
  ): void {
    switch (event.type) {
      case 'run.config':
        if (this.applyRunConfig(event.streamId, event.config)) {
          this.updateHeartbeat();
          this.render(true);
        }
        return;
      case 'conversation.progress':
        if (this.rootStreamTerminal) return;
        if (this.applyConversationProgress(streamId, event.progress)) {
          this.updateHeartbeat();
          this.render();
        }
        return;
      case 'stage.start': {
        if (this.rootStreamTerminal) return;
        const roundStage = roundStageFromStageStart(event);
        if (roundStage && this.applyRoundStage(streamId, roundStage)) {
          this.updateHeartbeat();
          this.render();
        }
        return;
      }
      case 'child.activity':
        if (this.rootStreamTerminal) return;
        this.applyActiveSubagents(event.parentStreamId, event.items);
        this.updateHeartbeat();
        this.render(true);
        return;
    }
    assertNever(event, 'Unhandled run-progress renderer run fact');
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

  private applyActiveSubagents(
    parentStreamId: StreamTabId,
    children: readonly ActiveChildInfo[],
  ): void {
    if (!this.claimRootStream(parentStreamId)) return;

    this.state.activeSubagents = formatActiveChildren(
      children.map((child) => child.agentName),
    );
  }

  private applyStatus(streamId: StreamTabId, status: StreamPhase): void {
    if (!this.isRootStream(streamId)) return;
    if (this.rootStreamStatus === status) return;

    this.rootStreamStatus = status;
    this.state.phase = formatStreamStatusLabel(status, { style: 'cli' });
    if (this.rootStreamTerminal) {
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
      const plannedRounds = this.state.plannedRounds;
      parts.push(
        `[${formatRoundStageLabel({
          index: this.state.round - 1,
          ...(isMultiRound(plannedRounds) ? { total: plannedRounds } : {}),
        })}]`,
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
    if (this.state.toolCallCount != null && !this.state.activeSubagents) {
      parts.push(`tools: ${this.state.toolCallCount}`);
    }
    parts.push(formatElapsed(now - this.startedAt));
    return parts.join(' · ');
  }
}

function formatInputLabel(files: readonly string[]): string | undefined {
  const first = files.at(0);
  if (!first) return undefined;

  const firstName = path.basename(first);
  return files.length === 1 ? firstName : `${firstName} +${files.length - 1}`;
}

function formatActiveChildren(
  names: readonly (string | undefined)[],
): string | undefined {
  const namedChildren = names.filter((name): name is string => Boolean(name));
  const first = namedChildren[0];
  if (!first) return undefined;

  const label = pluralize(namedChildren.length, 'subagent');
  const suffix =
    namedChildren.length > 1 ? ` +${namedChildren.length - 1}` : '';
  return `${label}: ${first}${suffix}`;
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
