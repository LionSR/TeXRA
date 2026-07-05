import { cp, stat } from 'node:fs/promises';
import * as path from 'node:path';

import {
  deleteAllExecutions,
  deleteExecution,
  getExecutionStore,
  listExecutions,
  type ExecutionListingEntry,
  type ExecutionMeta,
  type ResultMeta,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ChatExportInput } from '@agent/export/schemas';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  EXECUTION_STATUS,
  ExecutionIdSchema,
  type ExecutionId,
} from '@shared/schemas';
import { GoalStore } from '@tools/goal';

import { readCliToolUseResumeDataForListing } from './toolUseResumeData';
import { formatCliHistoryAgentLabel } from './historyLabels';
import {
  createConversationPreview,
  createConversationTranscript,
  formatConversationPreview,
  formatConversationTranscript,
} from './history/conversationFormat';
import {
  listGeneratedFiles,
  listWorkspaceToolFiles,
  mergeHistoryFiles,
} from './history/generatedFiles';

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
  return ExecutionIdSchema.optional().catch(undefined).parse(raw);
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

/**
 * Load a stored execution's config + conversation as the format-agnostic
 * {@link ChatExportInput} the html/markdown export formatters consume.
 * Mirrors the extension's `ChatExportController.buildExportInput` so the CLI
 * and extension render the same conversation identically.
 *
 * Returns `null` (not a discriminated "which piece is missing" result) when
 * either the config or the conversation is absent, so the caller can report
 * the same "not found" message `history show` uses for missing executions.
 */
export async function readCliHistoryExportInput(
  id: ExecutionId,
): Promise<ChatExportInput | null> {
  const store = getExecutionStore(id);
  const [rawConfig, conversation, meta] = await Promise.all([
    store.readConfig(),
    store.readConversation(),
    store.readMeta(),
  ]);
  if (!rawConfig || !conversation) return null;

  const config = AgentConfigSchema.parse(rawConfig);
  return {
    timestamp: meta?.timestamp ?? new Date().toISOString(),
    description: meta?.description,
    config: {
      agent: config.agent,
      model: config.model,
      instruction: config.instruction,
      inputFiles: config.inputFiles,
      mediaFiles: config.mediaFiles,
      contextFiles: config.contextFiles,
      outputFiles: config.outputFiles,
    },
    messages: conversation,
  };
}

/**
 * Resolves the `--assets` flag value to the href passed into
 * `formatChatAsHtml`. Blank (`undefined`, empty, or whitespace-only) collapses
 * to `undefined` so the formatter's own documented `./assets` default applies
 * — `--assets ''` must behave identically to omitting the flag, not produce a
 * broken empty href.
 */
export function resolveCliHistoryExportAssetsHref(
  raw: string | undefined,
): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * True when `href` names a remote location (has a URL scheme, e.g.
 * `https://cdn/assets`) rather than a filesystem path. There is nothing to
 * stage for a remote href — the caller manages that location themselves.
 * A bare relative/absolute filesystem path (`./assets`, `assets`,
 * `/abs/path`) is never mistaken for one: it has no `scheme://` prefix.
 */
export function isRemoteCliHistoryExportAssetsHref(
  href: string | undefined,
): boolean {
  return href !== undefined && /^[a-z][a-z\d+.-]*:\/\//i.test(href);
}

const HTML_EXPORT_ASSET_DIR_NAME = 'htmlExport';

/**
 * Stage the bundled KaTeX / highlight.js / texmath CSS + font assets into
 * `destDir` (e.g. `<cwd>/assets`) so a default `--export html > out.html`
 * redirect — written to the same directory — resolves the exported
 * document's `./assets` href for real, instead of linking to a folder that
 * was never created.
 *
 * Called for the default href *and* any explicit local `--assets <href>`
 * (including one that happens to spell out the documented default, e.g.
 * `--assets ./assets`) — `fs.cp`'s recursive copy merges into an existing
 * `destDir` rather than nesting under it, so staging is safe to repeat and
 * safe against a `destDir` that already has unrelated content. Only a
 * genuinely remote href (see {@link isRemoteCliHistoryExportAssetsHref})
 * skips staging, since the caller manages that location themselves.
 *
 * Returns `'missing'` (without throwing) when the CLI install doesn't have
 * the bundled assets — e.g. a dev checkout where `copy:resources` hasn't run
 * — so the caller can warn instead of failing the export outright.
 */
export async function stageCliHistoryExportAssets(params: {
  readonly resourcesPath: string;
  readonly destDir: string;
}): Promise<'staged' | 'missing'> {
  const assetsSrc = path.join(params.resourcesPath, HTML_EXPORT_ASSET_DIR_NAME);
  const sourceExists = await stat(assetsSrc)
    .then((info) => info.isDirectory())
    .catch(() => false);
  if (!sourceExists) return 'missing';

  await cp(assetsSrc, params.destDir, { recursive: true });
  return 'staged';
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
        historyListSubject(entry),
      ].join('\t'),
    )
    .join('\n');
}

function historyListSubject(
  entry: Pick<CliHistoryEntry, 'description' | 'inputBasename'>,
): string {
  if (entry.inputBasename !== '-') return entry.inputBasename;
  const description = entry.description?.replaceAll(/\s+/g, ' ').trim();
  return description || '-';
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
  if (input.hasFlowRecord && terminalStatusAllowsResume(input.terminalStatus)) {
    return CLI_HISTORY_RESUMABLE_STATUS;
  }
  return input.terminalStatus ?? 'unknown';
}

function terminalStatusAllowsResume(
  terminalStatus: string | undefined,
): boolean {
  return (
    terminalStatus === undefined ||
    terminalStatus === EXECUTION_STATUS.INTERRUPTED
  );
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
  const resumeData =
    terminalStatusAllowsResume(entry.terminalStatus) && entry.agentConfig
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
  return config?.cliMultiAgentPresetId?.trim() || undefined;
}

function firstInputBasename(config: AgentConfig | null): string {
  const first = config?.inputFiles.at(0) ?? '';
  return first ? path.basename(first) : '-';
}
