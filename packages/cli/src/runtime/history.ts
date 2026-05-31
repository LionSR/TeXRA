import * as path from 'node:path';

import {
  deleteAllExecutions,
  deleteExecution,
  getExecutionStore,
  listExecutionWorkspaceFiles,
  listExecutions,
  type ExecutionListingEntry,
  type ExecutionMeta,
  type ResultMeta,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { flowKey } from '@agent/node/persistedFlow';
import { isFileNotFoundError } from '@common/errors';
import { isDirectory } from '@common/files/fsEntryType';
import {
  EXECUTION_STATUS,
  ExecutionIdSchema,
  type ExecutionId,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { resolveStoragePath } from '@utils/files/taskRunStorage';

const HISTORY_FILE_SCAN_DEPTH = 2;
const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;
const WORKSPACE_FILE_TOOL_NAMES = new Set(['write_file', 'edit_file']);

const KV_FILES = new Set([
  'meta.json',
  'config.json',
  'conversation.json',
  'todos.json',
  'report.json',
  'workspace-files.json',
  'result-meta.json',
]);

export interface CliHistoryEntry {
  readonly id: ExecutionId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly status: string;
  readonly inputBasename: string;
  readonly category?: string;
  readonly description?: string;
}

export interface CliHistoryDetails {
  readonly id: ExecutionId;
  readonly meta: ExecutionMeta | null;
  readonly config: AgentConfig | null;
  readonly resultMeta: ResultMeta | null;
  readonly report: string | null;
  readonly conversationPreview: CliHistoryConversationPreview | null;
  readonly files: readonly CliHistoryFile[];
  readonly hasFlowRecord: boolean;
}

export interface CliHistoryConversationPreview {
  readonly messageCount: number;
  readonly messages: readonly CliHistoryConversationPreviewMessage[];
}

export interface CliHistoryConversationPreviewMessage {
  readonly index: number;
  readonly role: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface CliHistoryFile {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

export type CliHistoryDeleteResult =
  | { readonly deleted: 'all'; readonly count: number }
  | {
      readonly deleted: 'one';
      readonly id: ExecutionId;
      readonly found: boolean;
    };

export function parseCliHistoryId(raw: string): ExecutionId | undefined {
  return ExecutionIdSchema.safeParse(raw).success
    ? (raw as ExecutionId)
    : undefined;
}

export async function listCliHistoryEntries(): Promise<CliHistoryEntry[]> {
  const entries = await listExecutions();
  return entries.map(toCliHistoryEntry);
}

export async function readCliHistoryDetails(
  id: ExecutionId,
): Promise<CliHistoryDetails | null> {
  const store = getExecutionStore(id);
  const [
    meta,
    config,
    resultMeta,
    report,
    conversation,
    persistedWorkspaceFilePaths,
    generatedFiles,
    hasFlowRecord,
  ] = await Promise.all([
    store.readMeta(),
    store.readConfig(),
    store.readResultMeta(),
    store.readReport(),
    store.readConversation(),
    store.readWorkspaceFiles(),
    listGeneratedFiles(id),
    store.exists(flowKey(id)),
  ]);
  const conversationPreview = createConversationPreview(conversation);
  const workspaceFiles = await listWorkspaceToolFiles(
    config,
    persistedWorkspaceFilePaths,
    conversation,
  );
  const files = mergeHistoryFiles(generatedFiles, workspaceFiles);

  if (!meta && !config && !conversationPreview && !hasFlowRecord) return null;
  return {
    id,
    meta,
    config,
    resultMeta,
    report,
    conversationPreview,
    files,
    hasFlowRecord,
  };
}

export async function readCliHistoryConfig(
  id: ExecutionId,
): Promise<AgentConfig | null> {
  return getExecutionStore(id).readConfig();
}

export async function deleteCliHistory(options: {
  id?: ExecutionId;
  all?: boolean;
  /** Pre-computed entry count from `preflightCliHistoryDeleteAll`, surfaced in
   *  the `'all'` result so structured callers can report what was removed. */
  preCountForAll?: number;
}): Promise<CliHistoryDeleteResult> {
  if (options.all) {
    const count = options.preCountForAll ?? (await listExecutions()).length;
    await deleteAllExecutions();
    return { deleted: 'all', count };
  }
  if (!options.id) {
    throw new Error('Expected an execution id, or --all.');
  }
  return {
    deleted: 'one',
    id: options.id,
    found: await deleteExecution(options.id),
  };
}

/**
 * `texra history delete --all` is destructive and unrecoverable. The command
 * handler must call this first: if `--all` is set without `--yes`, it should
 * refuse and quote the count back to the user; otherwise it can pass `count`
 * into `deleteCliHistory` so the success report covers what was removed.
 */
export interface CliHistoryDeleteAllPreflight {
  readonly proceed: boolean;
  readonly count: number;
}

export async function preflightCliHistoryDeleteAll(options: {
  all?: boolean;
  yes?: boolean;
}): Promise<CliHistoryDeleteAllPreflight> {
  if (!options.all) return { proceed: false, count: 0 };
  const count = (await listExecutions()).length;
  return { proceed: options.yes === true, count };
}

export function formatCliHistoryText(
  entries: readonly CliHistoryEntry[],
): string {
  return entries.map(formatCliHistoryLine).join('\n');
}

function formatCliHistoryLine(entry: CliHistoryEntry): string {
  return [
    entry.id,
    entry.timestamp,
    entry.agent,
    entry.status,
    entry.inputBasename,
  ].join('\t');
}

export function cliHistoryNdjsonRecords(
  entries: readonly CliHistoryEntry[],
  ts = new Date().toISOString(),
): object[] {
  return entries.map((entry) => ({ kind: 'history-entry', ts, entry }));
}

export function formatCliHistoryDetailsText(
  details: CliHistoryDetails,
): string {
  const { config, meta } = details;
  const lines = [
    `Execution: ${details.id}`,
    `Status: ${meta?.terminalStatus ?? EXECUTION_STATUS.COMPLETED}`,
    `Timestamp: ${meta?.timestamp ?? 'unknown'}`,
    `Agent: ${config?.agent ?? 'unknown'}`,
    `Model: ${config?.model ?? 'unknown'}`,
  ];

  if (config?.agentCategory) lines.push(`Category: ${config.agentCategory}`);
  if (meta?.parentExecutionId) lines.push(`Parent: ${meta.parentExecutionId}`);
  if (meta?.description) lines.push(`Description: ${meta.description}`);
  if (details.resultMeta) {
    lines.push(`Result: ${JSON.stringify(details.resultMeta)}`);
  }
  if (details.report) {
    lines.push('', 'Report:', details.report);
  } else if (details.conversationPreview) {
    lines.push('', formatConversationPreview(details.conversationPreview));
  }
  lines.push('', 'Config:', JSON.stringify(config ?? {}, null, 2));
  lines.push('', `Files (${details.files.length}):`);
  lines.push(
    ...(details.files.length
      ? details.files.map(formatCliHistoryFile)
      : ['(none)']),
  );
  if (details.hasFlowRecord) lines.push('', 'Flow record: present');
  return lines.join('\n');
}

function toCliHistoryEntry(entry: ExecutionListingEntry): CliHistoryEntry {
  const inputBasename = firstInputBasename(entry.agentConfig);
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    agent: entry.agent,
    model: entry.model,
    status: entry.terminalStatus ?? EXECUTION_STATUS.COMPLETED,
    inputBasename,
    category: entry.category,
    description: entry.description,
  };
}

function firstInputBasename(config: AgentConfig | null): string {
  const first = config?.inputFiles.at(0) ?? '';
  return first ? path.basename(first) : '-';
}

function isHistoryKvFile(name: string): boolean {
  return (
    KV_FILES.has(name) || name.startsWith('child-') || name.startsWith('flow_')
  );
}

function formatCliHistoryFile(file: CliHistoryFile): string {
  const kind = file.isDirectory ? '<dir>' : `${file.size}`;
  return `${kind}\t${file.path}`;
}

function createConversationPreview(
  conversation: readonly unknown[] | null,
): CliHistoryConversationPreview | null {
  if (!conversation?.length) return null;
  const messages = conversation
    .map((message, i) => toConversationPreviewMessage(message, i + 1))
    .filter((message) => message.content.trim().length > 0);
  if (!messages.length) return null;

  const lastAssistant = messages.findLast(
    (message) => message.role === 'assistant',
  );
  const selected = lastAssistant
    ? [lastAssistant]
    : messages.slice(-CONVERSATION_PREVIEW_MESSAGE_LIMIT);

  return {
    messageCount: conversation.length,
    messages: selected,
  };
}

function toConversationPreviewMessage(
  message: unknown,
  index: number,
): CliHistoryConversationPreviewMessage {
  const raw = isRecord(message) ? message : {};
  const role = typeof raw.role === 'string' ? raw.role : 'unknown';
  const content = formatConversationMessageContent(raw.content);
  const truncated = content.length > CONVERSATION_PREVIEW_CONTENT_LIMIT;
  return {
    index,
    role,
    content: truncated
      ? `${content.slice(0, CONVERSATION_PREVIEW_CONTENT_LIMIT).trimEnd()}\n...[truncated]`
      : content,
    truncated,
  };
}

function formatConversationPreview(
  preview: CliHistoryConversationPreview,
): string {
  const shown =
    preview.messages.length === 1
      ? `${preview.messages[0]?.role ?? 'message'} message ${preview.messages[0]?.index ?? '?'}`
      : `${preview.messages.length} recent messages`;
  const lines = [
    `Conversation (${preview.messageCount} messages; showing ${shown}):`,
  ];
  for (const message of preview.messages) {
    lines.push('', `[${message.role} #${message.index}]`, message.content);
  }
  return lines.join('\n');
}

function formatConversationMessageContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(formatConversationContentBlock).join('\n').trim();
  }
  return formatJsonish(content);
}

function formatConversationContentBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!isRecord(block)) return formatJsonish(block);
  if (typeof block.text === 'string') return block.text;

  switch (block.type) {
    case 'tool_use':
      return `[tool_use: ${String(block.name ?? 'unknown')}]`;
    case 'tool_result':
      return `[tool_result: ${formatConversationMessageContent(block.content)}]`;
    default:
      return formatJsonish(block);
  }
}

function formatJsonish(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function listGeneratedFiles(id: ExecutionId): Promise<CliHistoryFile[]> {
  const runDir = await resolveStoragePath(id);
  if (!runDir) return [];
  return walkStorageDirectory(runDir, '', HISTORY_FILE_SCAN_DEPTH);
}

async function walkStorageDirectory(
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Promise<CliHistoryFile[]> {
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
  const entries = await StorageFS.readDir(fullPath).catch((error: unknown) => {
    if (isFileNotFoundError(error)) return [];
    throw error;
  });

  const files: CliHistoryFile[] = [];
  for (const [name, type] of entries) {
    if (isHistoryKvFile(name)) continue;
    const rawRelative = relativePath ? path.join(relativePath, name) : name;
    const childPath = path.join(basePath, rawRelative);
    const entryIsDirectory = isDirectory(type);
    const stat = await StorageFS.stat(childPath).catch(() => ({ size: 0 }));
    files.push({
      path: rawRelative.replaceAll('\\', '/'),
      size: stat.size,
      isDirectory: entryIsDirectory,
    });
    if (entryIsDirectory && maxDepth > 1) {
      files.push(
        ...(await walkStorageDirectory(basePath, rawRelative, maxDepth - 1)),
      );
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function listWorkspaceToolFiles(
  config: AgentConfig | null,
  persistedPaths: readonly string[],
  conversation: readonly unknown[] | null,
): Promise<CliHistoryFile[]> {
  const filePaths = persistedPaths.length
    ? persistedPaths
    : conversation?.length
      ? extractWorkspaceFileToolPaths(conversation)
      : [];
  const workspaceFiles = await listExecutionWorkspaceFiles(config, filePaths);
  return workspaceFiles.map((file) => ({
    path: file.displayPath,
    size: file.size,
    isDirectory: file.isDirectory,
  }));
}

function extractWorkspaceFileToolPaths(
  conversation: readonly unknown[],
): string[] {
  const paths: string[] = [];
  for (const message of conversation) {
    if (!isRecord(message)) continue;

    const responseToolPath = extractResponseFunctionCallFilePath(message);
    if (responseToolPath) paths.push(responseToolPath);

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    for (const toolCall of toolCalls) {
      const toolPath = extractOpenAiToolCallFilePath(toolCall);
      if (toolPath) paths.push(toolPath);
    }

    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    for (const block of contentBlocks) {
      const toolPath = extractContentToolUseFilePath(block);
      if (toolPath) paths.push(toolPath);
    }

    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      const toolPath = extractGoogleFunctionCallFilePath(part);
      if (toolPath) paths.push(toolPath);
    }
  }
  return paths;
}

function extractResponseFunctionCallFilePath(
  message: Record<string, unknown>,
): string | undefined {
  if (message.type !== 'function_call') return undefined;
  if (
    typeof message.name !== 'string' ||
    !WORKSPACE_FILE_TOOL_NAMES.has(message.name)
  ) {
    return undefined;
  }
  return extractToolArgumentsFilePath(message.arguments);
}

function extractOpenAiToolCallFilePath(toolCall: unknown): string | undefined {
  if (!isRecord(toolCall)) return undefined;
  const fn = isRecord(toolCall.function) ? toolCall.function : {};
  if (typeof fn.name !== 'string' || !WORKSPACE_FILE_TOOL_NAMES.has(fn.name)) {
    return undefined;
  }
  return extractToolArgumentsFilePath(fn.arguments);
}

function extractContentToolUseFilePath(block: unknown): string | undefined {
  if (!isRecord(block) || block.type !== 'tool_use') return undefined;
  if (
    typeof block.name !== 'string' ||
    !WORKSPACE_FILE_TOOL_NAMES.has(block.name)
  ) {
    return undefined;
  }
  return extractToolArgumentsFilePath(block.input);
}

function extractGoogleFunctionCallFilePath(part: unknown): string | undefined {
  if (!isRecord(part) || !isRecord(part.functionCall)) return undefined;
  const { functionCall } = part;
  if (
    typeof functionCall.name !== 'string' ||
    !WORKSPACE_FILE_TOOL_NAMES.has(functionCall.name)
  ) {
    return undefined;
  }
  return extractToolArgumentsFilePath(functionCall.args);
}

function extractToolArgumentsFilePath(
  argumentsValue: unknown,
): string | undefined {
  const args = parseToolArguments(argumentsValue);
  const toolPath = typeof args?.path === 'string' ? args.path.trim() : '';
  return toolPath || undefined;
}

function parseToolArguments(
  argumentsValue: unknown,
): Record<string, unknown> | undefined {
  if (isRecord(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(argumentsValue);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mergeHistoryFiles(
  ...fileGroups: readonly (readonly CliHistoryFile[])[]
): CliHistoryFile[] {
  const files = new Map<string, CliHistoryFile>();
  for (const group of fileGroups) {
    for (const file of group) {
      if (!files.has(file.path)) files.set(file.path, file);
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
