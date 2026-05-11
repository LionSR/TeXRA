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
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
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
  /exit, /quit     Exit chat

Keys:
  Ctrl-C           Interrupt the active session, or exit if no session is running
  Ctrl-D           Exit when the prompt is waiting for input`);
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
    switch (event) {
      case 'showToolEditPermission':
        this.renderToolEditApproval(payload);
        return;
      case 'showBashPermission':
        this.renderBashApproval(payload);
        return;
      case 'showAgentProposal':
        this.renderAgentProposalApproval(payload);
        return;
      case 'showPlanApproval':
        this.renderPlanApproval(payload);
        return;
      case 'showExternalInquiry':
        this.renderExternalInquiryApproval(payload);
        return;
      case 'showRetryRequest':
        this.renderRetryApproval(payload);
        return;
      default:
        this.renderCard('approval requested', [event]);
    }
  }

  private renderToolEditApproval(payload: unknown): void {
    const relativePath =
      stringField(payload, 'relativePath') ??
      stringField(payload, 'path') ??
      'unknown file';
    const sourceTool = stringField(payload, 'sourceTool') ?? 'unknown tool';
    const added = numberField(payload, 'addedLines') ?? 0;
    const removed = numberField(payload, 'removedLines') ?? 0;
    const lines = [
      `tool: ${sourceTool}`,
      `delta: +${added} -${removed}`,
      `bypass allowed: ${booleanField(payload, 'allowBypass') ?? false}`,
    ];
    if (this.toolDisplay === 'grouped') {
      const path = stringField(payload, 'path');
      if (path && path !== relativePath) lines.push(`path: ${path}`);
    }
    this.renderCard(`approval: edit ${relativePath}`, lines);
  }

  private renderBashApproval(payload: unknown): void {
    const command = stringField(payload, 'command') ?? 'unknown command';
    const maxLength = this.toolDisplay === 'grouped' ? 520 : 180;
    this.renderCard('approval: bash command', [
      truncateText(command.replaceAll('\n', ' && '), maxLength),
      `bypass allowed: ${booleanField(payload, 'allowBypass') ?? false}`,
    ]);
  }

  private renderAgentProposalApproval(payload: unknown): void {
    const agent = stringField(payload, 'agent') ?? 'unknown agent';
    const model = stringField(payload, 'model') ?? 'unknown model';
    const instruction = stringField(payload, 'instruction');
    const files = [
      ...arrayField(payload, 'inputFiles'),
      ...arrayField(payload, 'outputFiles'),
      ...arrayField(payload, 'memories'),
    ];
    const lines = [
      `agent: ${agent}`,
      `model: ${model}`,
      `files: ${files.length}`,
    ];
    if (instruction) {
      const maxLength = this.toolDisplay === 'grouped' ? 420 : 160;
      lines.push(`instruction: ${truncateText(instruction, maxLength)}`);
    }
    this.renderCard('approval: agent proposal', lines);
  }

  private renderPlanApproval(payload: unknown): void {
    const plan = isRecord(payload) ? payload.plan : undefined;
    const summary = stringField(plan, 'summary') ?? 'plan approval requested';
    const steps = arrayField(plan, 'steps');
    const lines = [`summary: ${truncateText(summary, 180)}`];
    if (steps.length > 0) lines.push(`steps: ${steps.length}`);
    if (this.toolDisplay === 'grouped') {
      for (const [index, step] of steps.entries()) {
        const title = stringField(step, 'title') ?? `step ${index + 1}`;
        const status = stringField(step, 'status') ?? 'unknown';
        lines.push(`${index + 1}. [${status}] ${truncateText(title, 120)}`);
      }
    }
    this.renderCard('approval: plan', lines);
  }

  private renderExternalInquiryApproval(payload: unknown): void {
    const question = stringField(payload, 'question') ?? 'human input needed';
    const lines = [`question: ${truncateText(question, 220)}`];
    const context = stringField(payload, 'context');
    const attachFiles = arrayField(payload, 'attachFiles');
    const sessionLinks = arrayField(payload, 'sessionLinks');
    if (context && this.toolDisplay === 'grouped') {
      lines.push(`context: ${truncateText(context, 260)}`);
    }
    if (attachFiles.length > 0) {
      lines.push(`attached files: ${attachFiles.length}`);
    }
    if (sessionLinks.length > 0) {
      lines.push(`session links: ${sessionLinks.length}`);
    }
    this.renderCard('approval: external inquiry', lines);
  }

  private renderRetryApproval(payload: unknown): void {
    const operation = stringField(payload, 'operation') ?? 'operation';
    const model = stringField(payload, 'model');
    const errorMessage = stringField(payload, 'errorMessage');
    const lines = [
      `operation: ${operation}`,
      ...(model ? [`model: ${model}`] : []),
      ...(errorMessage ? [`error: ${truncateText(errorMessage, 220)}`] : []),
    ];
    this.renderCard('approval: retry request', lines);
  }

  private renderCard(title: string, lines: string[]): void {
    const cardLines = [
      `-- ${title} --`,
      ...lines.map((line) => `| ${line}`),
      '-- approval is handled by the CLI approval adapter --',
    ];
    for (const line of cardLines) this.warn(line);
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
