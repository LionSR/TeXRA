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
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { isFileNotFoundError } from '@common/errors';
import {
  EXECUTION_STATUS,
  ExecutionIdSchema,
  type ExecutionId,
} from '@shared/schemas';
import { GoalStore } from '@tools/goal';
import { StorageFS } from '@utils/files';
import { byStringProp } from '@utils/core/comparators';
import { isObject } from '@utils/core/typeGuards';
import { isDirectory } from '@utils/files/fsEntryType';
import { resolveStoragePath } from '@utils/files/taskRunStorage';

import { readCliToolUseResumeDataForListing } from './toolUseResumeData';
import { formatCliHistoryAgentLabel } from './historyLabels';

const HISTORY_FILE_SCAN_DEPTH = 2;
const CONVERSATION_PREVIEW_MESSAGE_LIMIT = 3;
const CONVERSATION_PREVIEW_CONTENT_LIMIT = 4000;
const HIDDEN_PROVIDER_REASONING_MARKER = '[provider reasoning hidden]';
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

interface ConversationMessageFormatOptions {
  readonly includeToolUseMarkers?: boolean;
  readonly contentLimit?: number;
}

export interface CliHistoryEntry {
  readonly id: ExecutionId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly status: string;
  readonly inputBasename: string;
  readonly category?: string;
  readonly description?: string;
  readonly teamPresetId?: string;
  readonly parentExecutionId?: ExecutionId;
  readonly delegationDepth?: number;
}

export interface CliHistoryDetails {
  readonly id: ExecutionId;
  readonly status: string;
  readonly meta: ExecutionMeta | null;
  readonly config: AgentConfig | null;
  readonly resultMeta: ResultMeta | null;
  readonly report: string | null;
  readonly conversationPreview: CliHistoryConversationPreview | null;
  readonly conversation?: CliHistoryConversationPreview | null;
  readonly files: readonly CliHistoryFile[];
  readonly hasFlowRecord: boolean;
  readonly currentModel?: string;
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

export const CLI_HISTORY_RESUMABLE_STATUS = 'resumable';

function isCliHistoryEntryResumable(
  entry: Pick<CliHistoryEntry, 'status'>,
): boolean {
  return entry.status === CLI_HISTORY_RESUMABLE_STATUS;
}

export function resumableCliHistoryEntries<
  T extends Pick<CliHistoryEntry, 'status'>,
>(entries: readonly T[]): T[] {
  return entries.filter(isCliHistoryEntryResumable);
}

function isCliHistoryEntryUserStarted(
  entry: Pick<CliHistoryEntry, 'parentExecutionId' | 'delegationDepth'>,
): boolean {
  return (
    entry.parentExecutionId === undefined && (entry.delegationDepth ?? 0) === 0
  );
}

export function userStartedCliHistoryEntries<
  T extends Pick<CliHistoryEntry, 'parentExecutionId' | 'delegationDepth'>,
>(entries: readonly T[]): T[] {
  return entries.filter(isCliHistoryEntryUserStarted);
}

export type CliHistoryDeleteResult =
  | { readonly deleted: 'all'; readonly count: number }
  | {
      readonly deleted: 'one';
      readonly id: ExecutionId;
      readonly found: boolean;
    };

export function parseCliHistoryId(raw: string): ExecutionId | undefined {
  const parsed = ExecutionIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function listCliHistoryEntries(): Promise<CliHistoryEntry[]> {
  const entries = await listExecutions();
  const history: CliHistoryEntry[] = [];
  for (const entry of entries) {
    history.push(await toCliHistoryEntry(entry));
  }
  return history;
}

export async function readCliHistoryDetails(
  id: ExecutionId,
  options: { includeFullConversation?: boolean } = {},
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
  ] = await Promise.all([
    store.readMeta(),
    store.readConfig(),
    store.readResultMeta(),
    store.readReport(),
    store.readConversation(),
    store.readWorkspaceFiles(),
    listGeneratedFiles(id),
  ]);
  const resumeData = config
    ? await readCliToolUseResumeDataForListing(id, config)
    : undefined;
  const conversationPreview = createConversationPreview(conversation);
  const fullConversation = options.includeFullConversation
    ? createConversationTranscript(conversation)
    : undefined;
  const workspaceFiles = await listWorkspaceToolFiles(
    config,
    persistedWorkspaceFilePaths,
    conversation,
  );
  const files = mergeHistoryFiles(generatedFiles, workspaceFiles);

  if (
    !meta &&
    !config &&
    !conversationPreview &&
    !fullConversation &&
    !resumeData
  ) {
    return null;
  }
  return {
    id,
    status: resolveCliHistoryStatus({
      terminalStatus: meta?.terminalStatus,
      hasFlowRecord: !!resumeData,
    }),
    meta,
    config,
    resultMeta,
    report,
    conversationPreview,
    ...(options.includeFullConversation
      ? { conversation: fullConversation }
      : {}),
    files,
    hasFlowRecord: !!resumeData,
    currentModel: resumeData?.snapshot.agentConfig.model,
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
    const deletedExecutionIds = await deleteAllExecutions();
    await GoalStore.forgetByExecutionIds(deletedExecutionIds);
    const count = options.preCountForAll ?? deletedExecutionIds.length;
    return { deleted: 'all', count };
  }
  if (!options.id) {
    throw new Error('Expected an execution id, or --all.');
  }
  const found = await deleteExecution(options.id);
  if (found) {
    await GoalStore.forgetByExecutionIds([options.id]);
  }
  return {
    deleted: 'one',
    id: options.id,
    found,
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
  return entries
    .map((entry) =>
      [
        entry.id,
        entry.timestamp,
        formatCliHistoryAgentLabel(entry),
        entry.status,
        entry.inputBasename,
      ].join('\t'),
    )
    .join('\n');
}

export function formatCliHistoryNotFoundText(
  id: ExecutionId,
  cwd?: string,
): string {
  const workspace = cwd?.trim();
  return [
    workspace
      ? `Execution not found in workspace ${workspace}: ${id}`
      : `Execution not found: ${id}`,
    'History is scoped by --cwd; use the workspace from the original run or run `texra history list --cwd <workspace>`.',
  ].join('\n');
}

export function cliHistoryNdjsonRecords(
  entries: readonly CliHistoryEntry[],
  ts = new Date().toISOString(),
): CliNdjsonRecord[] {
  return entries.map((entry) => ({ kind: 'history-entry', ts, entry }));
}

export function resolveCliHistoryStatus(input: {
  readonly terminalStatus?: string;
  readonly hasFlowRecord?: boolean;
}): string {
  // An absent terminal status means the run never reached its terminal write
  // (crash, kill, old build) — never report that as 'completed'.
  if (
    input.hasFlowRecord &&
    (input.terminalStatus === undefined ||
      input.terminalStatus === EXECUTION_STATUS.INTERRUPTED)
  ) {
    return CLI_HISTORY_RESUMABLE_STATUS;
  }
  return input.terminalStatus ?? 'unknown';
}

export function formatCliHistoryDetailsText(
  details: CliHistoryDetails,
): string {
  const { config, meta } = details;
  const model = details.currentModel ?? config?.model;
  const teamPreset = teamPresetId(config);
  const cliOutputFile = config?.cliOutputFile?.trim();
  const lines = [
    `Execution: ${details.id}`,
    `Status: ${details.status}`,
    `Timestamp: ${meta?.timestamp ?? 'unknown'}`,
    `Agent: ${config?.agent ?? 'unknown'}`,
    `Model: ${model ?? 'unknown'}`,
  ];

  if (teamPreset) {
    lines.push(`Team: ${teamPreset}`);
  }
  if (
    details.currentModel &&
    config?.model &&
    details.currentModel !== config.model
  ) {
    lines.push(`Startup model: ${config.model}`);
  }
  if (config?.agentCategory) lines.push(`Category: ${config.agentCategory}`);
  if (cliOutputFile) lines.push(`CLI output: ${cliOutputFile}`);
  if (meta?.parentExecutionId) lines.push(`Parent: ${meta.parentExecutionId}`);
  if (meta?.delegationDepth !== undefined) {
    lines.push(`Delegation depth: ${meta.delegationDepth}`);
  }
  if (meta?.description) lines.push(`Description: ${meta.description}`);
  if (details.resultMeta) {
    lines.push(`Result: ${JSON.stringify(details.resultMeta)}`);
  }
  if (details.report) {
    lines.push('', 'Report:', details.report);
  }
  if (details.conversation) {
    lines.push('', formatConversationTranscript(details.conversation));
  } else if (!details.report && details.conversationPreview) {
    lines.push('', formatConversationPreview(details.conversationPreview));
  }
  lines.push('', 'Config:', JSON.stringify(config ?? {}, null, 2));
  lines.push('', `Files (${details.files.length}):`);
  lines.push(
    ...(details.files.length
      ? details.files.map(
          (file) => `${file.isDirectory ? '<dir>' : file.size}\t${file.path}`,
        )
      : ['(none)']),
  );
  if (details.hasFlowRecord) lines.push('', 'Resumable flow record: present');
  return lines.join('\n');
}

async function toCliHistoryEntry(
  entry: ExecutionListingEntry,
): Promise<CliHistoryEntry> {
  const inputBasename = firstInputBasename(entry.agentConfig);
  // Cancelled sessions persist 'interrupted' and may keep a resumable flow
  // record — check it for those too, not only for missing terminal statuses.
  const mayBeResumable =
    entry.terminalStatus === undefined ||
    entry.terminalStatus === EXECUTION_STATUS.INTERRUPTED;
  const resumeData =
    mayBeResumable && entry.agentConfig
      ? await readCliToolUseResumeDataForListing(entry.id, entry.agentConfig)
      : null;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    agent: entry.agent,
    model: resumeData?.snapshot.agentConfig.model ?? entry.model,
    status: resolveCliHistoryStatus({
      terminalStatus: entry.terminalStatus,
      hasFlowRecord: !!resumeData,
    }),
    inputBasename,
    category: entry.category,
    description: entry.description,
    teamPresetId: teamPresetId(entry.agentConfig),
    parentExecutionId: entry.parentExecutionId,
    delegationDepth: entry.delegationDepth,
  };
}

function teamPresetId(config: AgentConfig | null): string | undefined {
  const preset = config?.cliMultiAgentPresetId?.trim();
  return preset ? preset : undefined;
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

function createConversationPreview(
  conversation: readonly unknown[] | null,
): CliHistoryConversationPreview | null {
  const transcript = buildConversationMessages(conversation, {
    includeToolUseMarkers: false,
    contentLimit: CONVERSATION_PREVIEW_CONTENT_LIMIT,
  });
  if (!transcript) return null;

  const lastAssistant = transcript.messages.findLast((message) =>
    isAssistantMessageRole(message.role),
  );
  const selected = lastAssistant
    ? [lastAssistant]
    : transcript.messages.slice(-CONVERSATION_PREVIEW_MESSAGE_LIMIT);

  return {
    messageCount: transcript.messageCount,
    messages: selected,
  };
}

function createConversationTranscript(
  conversation: readonly unknown[] | null,
): CliHistoryConversationPreview | null {
  return buildConversationMessages(conversation, {
    includeToolUseMarkers: true,
  });
}

function buildConversationMessages(
  conversation: readonly unknown[] | null,
  options: ConversationMessageFormatOptions,
): CliHistoryConversationPreview | null {
  if (!conversation?.length) return null;
  const messages = conversation
    .map((message, i) => toConversationPreviewMessage(message, i + 1, options))
    .filter((message) => message.content.trim().length > 0);
  if (!messages.length) return null;
  return {
    messageCount: conversation.length,
    messages,
  };
}

function toConversationPreviewMessage(
  message: unknown,
  index: number,
  options: ConversationMessageFormatOptions,
): CliHistoryConversationPreviewMessage {
  const raw = isObject(message) ? message : {};
  const role = typeof raw.role === 'string' ? raw.role : 'unknown';
  const content = formatConversationMessage(raw, options);
  const truncated =
    options.contentLimit !== undefined && content.length > options.contentLimit;
  return {
    index,
    role,
    content: truncated
      ? `${content.slice(0, options.contentLimit).trimEnd()}\n...[truncated]`
      : content,
    truncated,
  };
}

function formatConversationMessage(
  raw: Record<string, unknown>,
  options: ConversationMessageFormatOptions,
): string {
  const role = typeof raw.role === 'string' ? raw.role : '';
  const parts = [
    formatConversationMessageContent(raw.content, options),
    formatConversationMessageContent(raw.parts, options),
    ...(options.includeToolUseMarkers === true
      ? formatTopLevelToolCalls(raw.tool_calls)
      : []),
  ].filter((part) => part.trim().length > 0);
  if (parts.length > 0) return parts.join('\n').trim();
  if (
    isAssistantMessageRole(role) &&
    (hasProviderReasoningBlock(raw.content) ||
      hasProviderReasoningBlock(raw.parts))
  ) {
    return HIDDEN_PROVIDER_REASONING_MARKER;
  }
  return '';
}

function isAssistantMessageRole(role: string): boolean {
  return role === 'assistant' || role === 'model';
}

function formatConversationPreview(
  preview: CliHistoryConversationPreview,
): string {
  const shown =
    preview.messages.length === 1
      ? `${preview.messages[0]?.role ?? 'message'} message ${preview.messages[0]?.index ?? '?'}`
      : `${preview.messages.length} recent messages`;
  return formatConversationMessages(preview, shown);
}

function formatConversationTranscript(
  transcript: CliHistoryConversationPreview,
): string {
  const shown =
    transcript.messages.length === transcript.messageCount
      ? 'all messages'
      : `${transcript.messages.length} non-empty messages`;
  return formatConversationMessages(transcript, shown);
}

function formatConversationMessages(
  transcript: CliHistoryConversationPreview,
  shown: string,
): string {
  const lines = [
    `Conversation (${transcript.messageCount} messages; showing ${shown}):`,
  ];
  for (const message of transcript.messages) {
    lines.push('', `[${message.role} #${message.index}]`, message.content);
  }
  return lines.join('\n');
}

function formatConversationMessageContent(
  content: unknown,
  options: ConversationMessageFormatOptions,
): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => formatConversationContentBlock(block, options))
      .join('\n')
      .trim();
  }
  return formatJsonish(content);
}

function formatConversationContentBlock(
  block: unknown,
  options: ConversationMessageFormatOptions,
): string {
  if (typeof block === 'string') return block;
  if (!isObject(block)) return formatJsonish(block);
  if (typeof block.text === 'string') return block.text;

  if (isObject(block.functionCall)) {
    if (options.includeToolUseMarkers !== true) return '';
    const name =
      typeof block.functionCall.name === 'string'
        ? block.functionCall.name
        : 'unknown';
    return `[tool_use: ${name}]`;
  }

  if (isObject(block.functionResponse)) {
    return `[tool_result: ${formatGoogleFunctionResponse(block.functionResponse, options)}]`;
  }

  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return '';
    case 'tool_use':
      if (options.includeToolUseMarkers !== true) return '';
      return `[tool_use: ${String(block.name ?? 'unknown')}]`;
    case 'tool_result':
      return `[tool_result: ${formatConversationMessageContent(block.content, options)}]`;
    default:
      return formatJsonish(block);
  }
}

function hasProviderReasoningBlock(content: unknown): boolean {
  if (Array.isArray(content)) return content.some(isProviderReasoningBlock);
  return isProviderReasoningBlock(content);
}

function isProviderReasoningBlock(block: unknown): boolean {
  return (
    isObject(block) &&
    (block.type === 'thinking' || block.type === 'redacted_thinking')
  );
}

function formatGoogleFunctionResponse(
  functionResponse: Record<string, unknown>,
  options: ConversationMessageFormatOptions,
): string {
  const response = isObject(functionResponse.response)
    ? functionResponse.response
    : undefined;
  if (response && Object.hasOwn(response, 'result')) {
    return formatConversationMessageContent(response.result, options);
  }
  if (response !== undefined) {
    return formatConversationMessageContent(response, options);
  }
  return formatJsonish(functionResponse);
}

function formatTopLevelToolCalls(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map(formatTopLevelToolCall);
}

function formatTopLevelToolCall(toolCall: unknown): string {
  if (!isObject(toolCall)) return `[tool_use: ${formatJsonish(toolCall)}]`;
  const nestedFunction = isObject(toolCall.function)
    ? toolCall.function
    : undefined;
  const name =
    typeof nestedFunction?.name === 'string'
      ? nestedFunction.name
      : typeof toolCall.name === 'string'
        ? toolCall.name
        : 'unknown';
  return `[tool_use: ${name}]`;
}

function formatJsonish(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
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
  return files.sort(byStringProp((f) => f.path));
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
    if (!isObject(message)) continue;

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
  if (!isObject(toolCall)) return undefined;
  const fn = isObject(toolCall.function) ? toolCall.function : {};
  if (typeof fn.name !== 'string' || !WORKSPACE_FILE_TOOL_NAMES.has(fn.name)) {
    return undefined;
  }
  return extractToolArgumentsFilePath(fn.arguments);
}

function extractContentToolUseFilePath(block: unknown): string | undefined {
  if (!isObject(block) || block.type !== 'tool_use') return undefined;
  if (
    typeof block.name !== 'string' ||
    !WORKSPACE_FILE_TOOL_NAMES.has(block.name)
  ) {
    return undefined;
  }
  return extractToolArgumentsFilePath(block.input);
}

function extractGoogleFunctionCallFilePath(part: unknown): string | undefined {
  if (!isObject(part) || !isObject(part.functionCall)) return undefined;
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
  if (isObject(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(argumentsValue);
    return isObject(parsed) ? parsed : undefined;
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
  return [...files.values()].sort(byStringProp((f) => f.path));
}
