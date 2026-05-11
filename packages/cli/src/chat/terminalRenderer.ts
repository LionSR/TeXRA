// Local imports - CLI runtime
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { writeRawStderr, writeTextStderr } from '../runtime/logSinks';

interface ChatSessionMetadata {
  readonly agent: string;
  readonly model: string;
  readonly cwd: string;
  readonly toolDisplay: ChatToolDisplayMode;
}

type TerminalTone = 'muted' | 'success' | 'warning' | 'error' | 'accent';

export type ChatToolDisplayMode = 'grouped' | 'minimal' | 'hidden';

const ANSI_RESET = '\u001B[0m';
const ANSI_TONES: Record<TerminalTone, string> = {
  muted: '\u001B[2m',
  success: '\u001B[32m',
  warning: '\u001B[33m',
  error: '\u001B[31m',
  accent: '\u001B[36m',
};

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

export class ChatTerminalRenderer {
  readonly prompt = 'user> ';

  private toolDisplay: ChatToolDisplayMode;
  private lastUsageSummary: string | undefined;

  constructor(
    private readonly colorEnabled: boolean,
    toolDisplay: ChatToolDisplayMode = 'minimal',
  ) {
    this.toolDisplay = toolDisplay;
  }

  setToolDisplay(mode: ChatToolDisplayMode): void {
    this.toolDisplay = mode;
    this.success(`Tool display set to ${mode}.`);
  }

  printBanner(metadata: ChatSessionMetadata): void {
    const cwd = basename(metadata.cwd);
    this.toolDisplay = metadata.toolDisplay;
    this.info(
      `texra chat plain mode. Agent: ${metadata.agent}. Model: ${metadata.model}. Workspace: ${cwd}. Tools: ${metadata.toolDisplay}. Type /help for commands.`,
    );
  }

  printHelp(): void {
    this.info(`Commands:
  /help            Show this help
  /agent <name>    Set the tool-use agent before the session starts
  /model <name>    Set the model before the session starts
  /tools <mode>    Set tool/progress rows: grouped, minimal, or hidden
  /status          Show active metadata and latest usage
  /yolo            Explain yolo approval mode
  /clear           Clear the terminal
  /exit, /quit     Exit chat`);
  }

  printStatus(
    metadata: ChatSessionMetadata,
    streamId: string | undefined,
  ): void {
    const cwd = basename(metadata.cwd);
    const stream = streamId ?? 'not started';
    const usage = this.lastUsageSummary ?? 'usage unavailable';
    this.info(
      `Agent: ${metadata.agent}. Model: ${metadata.model}. Workspace: ${cwd}. Stream: ${stream}. Tools: ${this.toolDisplay}. ${usage}.`,
    );
  }

  printClearScreen(): void {
    writeRawStderr('\u001B[2J\u001B[H');
  }

  renderProgressEvent<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    if (this.isApprovalEvent(event)) {
      this.renderApprovalEvent(event, payload);
      return;
    }
    if (this.toolDisplay === 'hidden') return;

    switch (event) {
      case 'updateConversationProgress':
        this.renderConversationProgress(payload);
        return;
      case 'updateStreamUsage':
        this.renderUsage(payload);
        return;
      case 'updateStreamDescription':
        this.renderDescription(payload);
        return;
      case 'updateTodos':
        this.renderCollectionSummary('todos', payload);
        return;
      case 'updatePlan':
        this.renderCollectionSummary('plan', payload);
        return;
      case 'updateActiveSubagents':
        this.renderActiveChildren('subagents', payload);
        return;
      case 'updateActiveProcesses':
        this.renderActiveChildren('processes', payload);
        return;
      case 'updateQueuedFollowUps':
        this.muted('follow-up queued');
        return;
      default:
        return;
    }
  }

  private renderConversationProgress(payload: unknown): void {
    const progress = isRecord(payload) ? payload.progress : undefined;
    const turns = numberField(progress, 'conversationTurns') ?? 0;
    const toolCalls = numberField(progress, 'toolCallCount') ?? 0;
    this.muted(`conversation: ${turns} turn(s), ${toolCalls} tool call(s)`);
  }

  private renderUsage(payload: unknown): void {
    const usage = isRecord(payload) ? payload.usage : undefined;
    const input = numberField(usage, 'inputTokens');
    const output = numberField(usage, 'outputTokens');
    const cost = numberField(usage, 'cost');
    const elapsed = numberField(usage, 'elapsedTime');
    const parts = [
      input == null ? undefined : `${input} input`,
      output == null ? undefined : `${output} output`,
      cost == null ? undefined : `$${cost.toFixed(4)}`,
      elapsed == null ? undefined : `${elapsed.toFixed(1)}s`,
    ].filter((part): part is string => part != null);
    if (parts.length === 0) return;
    this.lastUsageSummary = `usage: ${parts.join(', ')}`;
    this.muted(this.lastUsageSummary);
  }

  private renderDescription(payload: unknown): void {
    const description = stringField(payload, 'description');
    if (description) this.muted(`session: ${description}`);
  }

  private renderCollectionSummary(label: string, payload: unknown): void {
    if (this.toolDisplay === 'minimal') {
      this.muted(`${label} updated`);
      return;
    }
    const items =
      (isRecord(payload) && Array.isArray(payload.items) && payload.items) ||
      (isRecord(payload) && Array.isArray(payload.todos) && payload.todos) ||
      (isRecord(payload) && Array.isArray(payload.plan) && payload.plan) ||
      [];
    this.muted(`${label} updated: ${items.length} item(s)`);
  }

  private renderActiveChildren(label: string, payload: unknown): void {
    const children =
      isRecord(payload) && Array.isArray(payload.children)
        ? payload.children
        : isRecord(payload) && Array.isArray(payload.processes)
          ? payload.processes
          : [];
    if (children.length === 0) return;
    this.muted(`${label}: ${children.length} active`);
  }

  private isApprovalEvent(event: keyof ProgressEventPayloads): boolean {
    return (
      event === 'showToolEditPermission' ||
      event === 'showBashPermission' ||
      event === 'showAgentProposal' ||
      event === 'showPlanApproval' ||
      event === 'showExternalInquiry' ||
      event === 'showRetryRequest'
    );
  }

  private renderApprovalEvent(
    event: keyof ProgressEventPayloads,
    payload: unknown,
  ): void {
    const title =
      stringField(payload, 'title') ??
      stringField(payload, 'summary') ??
      stringField(payload, 'command') ??
      event;
    this.warn(`approval: ${title}`);
  }

  info(message: string): void {
    this.write('accent', message);
  }

  success(message: string): void {
    this.write('success', message);
  }

  warn(message: string): void {
    this.write('warning', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  private muted(message: string): void {
    this.write('muted', message);
  }

  private write(tone: TerminalTone, message: string): void {
    if (!this.colorEnabled) {
      writeTextStderr(message);
      return;
    }
    writeTextStderr(`${ANSI_TONES[tone]}${message}${ANSI_RESET}`);
  }
}
