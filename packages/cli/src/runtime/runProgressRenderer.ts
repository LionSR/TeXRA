import path from 'node:path';

// Local imports - progress events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - CLI runtime
import { writeRawStderr } from './logSinks';
import type { CliContext } from './cliContext';

type ProgressEvent = keyof ProgressEventPayloads;

interface RenderState {
  round?: number;
  toolCallCount?: number;
  agent?: string;
  inputFile?: string;
  phase?: string;
  activeWork?: string;
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
}

export function shouldRenderRunProgress(
  context: Pick<
    CliContext,
    'mode' | 'outputFormat' | 'quietLogs' | 'stderrIsTty'
  >,
): boolean {
  return context.quietLogs !== true && context.outputFormat === 'text';
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
  private readonly ansi: boolean;
  private lastRenderAt = 0;
  private lastLine = '';
  private liveLine = false;

  constructor(init: RunProgressRendererInit) {
    this.write = init.write ?? writeRawStderr;
    this.nowMs = init.nowMs ?? Date.now;
    this.minIntervalMs = init.minIntervalMs ?? 100;
    this.ansi = init.colorEnabled;
    this.startedAt = this.nowMs();
  }

  handle(event: ProgressEvent, payload: unknown): boolean {
    switch (event) {
      case 'setTaskState':
        this.applyTaskState(payload as ProgressEventPayloads['setTaskState']);
        this.render(true);
        return true;
      case 'updateConversationProgress':
        this.applyConversationProgress(
          payload as ProgressEventPayloads['updateConversationProgress'],
        );
        this.render();
        return true;
      case 'updateActiveProcesses':
        this.applyActiveProcesses(
          payload as ProgressEventPayloads['updateActiveProcesses'],
        );
        this.render(true);
        return true;
      case 'updateActiveSubagents':
        this.applyActiveSubagents(
          payload as ProgressEventPayloads['updateActiveSubagents'],
        );
        this.render(true);
        return true;
      case 'updateStreamStatus':
        this.state.phase = String(
          (payload as ProgressEventPayloads['updateStreamStatus']).status,
        );
        this.render(true);
        return true;
      case 'updateStreamDescription':
        this.state.phase = (
          payload as ProgressEventPayloads['updateStreamDescription']
        ).description;
        this.render(true);
        return true;
      default:
        return false;
    }
  }

  clear(): void {
    if (this.ansi && this.liveLine) {
      this.write('\r\x1b[2K');
      this.liveLine = false;
    }
  }

  preserve(): void {
    if (this.ansi && this.liveLine) {
      this.write('\n');
      this.liveLine = false;
    }
  }

  private applyTaskState(payload: ProgressEventPayloads['setTaskState']): void {
    const config = payload.taskState.agentConfig;
    this.state.agent = config.agent;
    this.state.inputFile = safeBasename(config.inputFiles.at(0));
    this.state.phase ??= 'running';
  }

  private applyConversationProgress(
    payload: ProgressEventPayloads['updateConversationProgress'],
  ): void {
    this.state.round = payload.progress.conversationTurns || undefined;
    this.state.toolCallCount = payload.progress.toolCallCount || undefined;
    this.state.phase ??= 'running';
  }

  private applyActiveProcesses(
    payload: ProgressEventPayloads['updateActiveProcesses'],
  ): void {
    const activeProcess = payload.processes[0];
    this.state.activeWork = activeProcess
      ? `tool: ${activeProcess.toolName ?? activeProcess.agentName}`
      : undefined;
  }

  private applyActiveSubagents(
    payload: ProgressEventPayloads['updateActiveSubagents'],
  ): void {
    const child = payload.children[0];
    this.state.activeWork = child ? `subagent: ${child.agentName}` : undefined;
  }

  private render(force = false): void {
    const now = this.nowMs();
    if (!force && now - this.lastRenderAt < this.minIntervalMs) return;

    const line = this.formatLine(now);
    if (!line || line === this.lastLine) return;

    if (this.ansi) {
      this.write(`\r\x1b[2K${line}`);
      this.liveLine = true;
    } else {
      this.write(`${line}\n`);
    }
    this.lastLine = line;
    this.lastRenderAt = now;
  }

  private formatLine(now: number): string {
    const parts: string[] = [];
    if (this.state.round != null) parts.push(`[r${this.state.round}]`);

    const subject = [this.state.agent, this.state.inputFile]
      .filter(Boolean)
      .join(' ');
    const phase = this.state.phase;
    parts.push(subject || phase || 'running');
    if (subject && phase && phase !== 'running') parts.push(phase);

    if (this.state.activeWork) parts.push(this.state.activeWork);
    if (this.state.toolCallCount != null && !this.state.activeWork) {
      parts.push(`tools: ${this.state.toolCallCount}`);
    }
    parts.push(formatElapsed(now - this.startedAt));
    return parts.join(' · ');
  }
}

function safeBasename(file: string | undefined): string | undefined {
  return file ? path.basename(file) : undefined;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
}
