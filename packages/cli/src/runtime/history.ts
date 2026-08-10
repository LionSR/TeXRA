import { cp, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import pMap from 'p-map';

import {
  deleteAllExecutions,
  deleteExecution,
  deriveResumability,
  getExecutionStore,
  isUserVisibleExecution,
  listExecutions,
  listExecutionWorkspaceFiles,
  unwrapResultMeta,
  type AgentExecutionListingEntry,
} from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { loadChatExportInput } from '@agent/export/loadChatExportInput';
import type { ChatExportInput } from '@agent/export/schemas';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  ExecutionIdSchema,
  RunOutcomeSchema,
  type ExecutionId,
  type ExecutionMeta,
} from '@shared/schemas';
import {
  resolveHistoryRunStatus,
  type HistoryRunStatus,
} from '@shared/schemas/settingsViewMessages';
import { runOutcomeToExecutionStatus } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
} from '@transcript';

import { readCliToolUseResumeDataForListing } from './toolUseResumeData';
import {
  formatCliHistoryAgentLabel,
  formatCliHistorySubject,
} from './historyLabels';
import {
  createConversationPreview,
  createConversationTranscript,
  formatConversationPreview,
  formatConversationTranscript,
} from './history/conversationFormat';
import {
  listGeneratedFiles,
  mergeHistoryFiles,
} from './history/generatedFiles';

const HISTORY_ENTRY_CONCURRENCY = 8;

export interface CliHistoryEntry {
  readonly id: ExecutionId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly status: HistoryRunStatus;
  readonly inputBasename: string;
  readonly category?: string;
  readonly description?: string;
  readonly teamPresetId?: string;
  readonly parentExecutionId?: ExecutionId;
}

export interface CliHistoryDetails {
  readonly id: ExecutionId;
  readonly status: string;
  readonly meta: ExecutionMeta | null;
  readonly config: AgentConfig | null;
  readonly result: ReturnType<typeof unwrapResultMeta> | null;
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

export function resumableCliHistoryEntries<
  T extends Pick<CliHistoryEntry, 'status'>,
>(entries: readonly T[]): T[] {
  return entries.filter(
    (entry) => entry.status === CLI_HISTORY_RESUMABLE_STATUS,
  );
}

export type CliHistoryDeleteResult =
  | {
      readonly deleted: 'all';
      readonly count: number;
      readonly active: readonly ExecutionId[];
      readonly failed: readonly {
        readonly executionId: ExecutionId;
        readonly message: string;
      }[];
    }
  | {
      readonly deleted: 'one';
      readonly id: ExecutionId;
      readonly found: boolean;
      readonly status: 'deleted' | 'not-found' | 'active';
    };

export function parseCliHistoryId(raw: string): ExecutionId | undefined {
  return ExecutionIdSchema.optional().catch(undefined).parse(raw);
}

export async function listCliHistoryEntries(): Promise<CliHistoryEntry[]> {
  const entries = await listExecutions();
  // Every row costs a resumability probe plus an optional resume-data read.
  // One at a time makes a long history crawl; all at once opens one file
  // handle burst per run, so keep it bounded. `pMap` preserves input order.
  return pMap(entries.filter(isUserVisibleExecution), toCliHistoryEntry, {
    concurrency: HISTORY_ENTRY_CONCURRENCY,
  });
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
    conversationResult,
    persistedWorkspaceFilePaths,
    generatedFiles,
    resumability,
  ] = await Promise.all([
    store.readMeta(),
    store.readConfig(),
    store.readResultMeta(),
    store.readReport(),
    // Transcript sidecar owns completed-run display (#7246 Decision 1).
    readCompletedRunConversation(id),
    store.readWorkspaceFiles(),
    listGeneratedFiles(id),
    deriveResumability(id),
  ]);
  const conversation = conversationResult.conversation;
  const hasTranscriptEvidence =
    hasCompletedRunConversationEvidence(conversationResult);
  const resumeData =
    resumability.resumable && config
      ? await readCliToolUseResumeDataForListing(id, config)
      : null;
  const conversationPreview = createConversationPreview(conversation);
  const fullConversation = options.includeFullConversation
    ? createConversationTranscript(conversation)
    : undefined;
  const workspaceFiles = await listExecutionWorkspaceFiles(
    config,
    persistedWorkspaceFilePaths,
  );
  const files = mergeHistoryFiles(
    generatedFiles,
    workspaceFiles.map((file) => ({
      path: file.displayPath,
      size: file.size,
      isDirectory: file.isDirectory,
    })),
  );

  if (
    !meta &&
    !config &&
    !conversationPreview &&
    !fullConversation &&
    !resumeData &&
    !hasTranscriptEvidence
  ) {
    return null;
  }
  return {
    id,
    status: resolveHistoryRunStatus({
      resumable: resumeData !== null,
      outcome: meta?.outcome,
    }),
    meta,
    config,
    result: resultMeta ? unwrapResultMeta(resultMeta) : null,
    report,
    conversationPreview,
    ...(options.includeFullConversation
      ? { conversation: fullConversation }
      : {}),
    files,
    hasFlowRecord: resumeData !== null,
    currentModel: resumeData?.agentConfig.model,
  };
}

/** Outcome of loading a stored execution's export input (see {@link readCliHistoryExportInput}). */
export type CliHistoryExportInputResult =
  | { readonly status: 'ok'; readonly exportInput: ChatExportInput }
  /** No trace of this execution at all — matches `history show`'s notion of "not found". */
  | { readonly status: 'not_found' }
  /** The execution exists (has meta and/or config) but is missing what an
   *  export needs (config and/or conversation) — a different failure than
   *  "not found", so it gets a different message. */
  | { readonly status: 'incomplete' };

/**
 * Load a stored execution's config + conversation as the format-agnostic
 * {@link ChatExportInput} the markdown export formatter consumes (the HTML
 * export path uses `assembleTrace` instead — see `commands/history.ts`).
 * Thin CLI-specific wrapper around the shared {@link loadChatExportInput}
 * loader, which also backs the extension's
 * `ChatExportController.buildExportInput` — so the CLI and extension render
 * the same conversation identically.
 *
 * Distinguishes "this execution id has no stored data at all" (`not_found`
 * — the same case `history show` reports as not found) from "this execution
 * exists but has nothing to export" (`incomplete` — e.g. `history show`
 * would still display it, just without a conversation to render). Reporting
 * both as "not found" would mislead a caller whose id is valid but whose
 * execution simply never produced a conversation.
 */
export async function readCliHistoryExportInput(
  id: ExecutionId,
): Promise<CliHistoryExportInputResult> {
  const { meta, config, conversation, hasTranscriptEvidence, exportInput } =
    await loadChatExportInput(id);
  if (exportInput) return { status: 'ok', exportInput };
  if (!meta && !config && !conversation && !hasTranscriptEvidence) {
    return { status: 'not_found' };
  }
  return { status: 'incomplete' };
}

/** Single-file default export template (file://-safe, inlined assets). */
const TRACE_VIEWER_DIR_NAME = 'traceViewer';
/** Multi-file shared-assets bundle for CLI `--assets-dir` site hosting. */
const TRACE_VIEWER_SHARED_DIR_NAME = 'traceViewerShared';

/**
 * Read the trace-viewer's single-file default bundle — one self-contained
 * `index.html` with no external `assets/` (JS/CSS/fonts all inlined) so the
 * default export opens correctly via `file://` with no server. Returns `null`
 * (without throwing) when the CLI install doesn't have the bundled template
 * — e.g. a dev checkout where `packages/trace-viewer` hasn't been built —
 * so the caller can report a clear error instead of an ENOENT stack trace.
 */
export async function readCliHistoryStandaloneTemplate(
  resourcesPath: string,
): Promise<string | null> {
  const templatePath = path.join(
    resourcesPath,
    TRACE_VIEWER_DIR_NAME,
    'index.html',
  );
  return readFile(templatePath, 'utf8').catch(() => null);
}

/**
 * Stage the trace-viewer's multi-file bundle (`index.html` + `assets/`) into
 * `destDir` for the shared-assets export mode (`--assets-dir`) — a site
 * hosting many traces points every trace's `?trace=` query param at one
 * shared bundle instead of duplicating it per trace. Unlike the default
 * single-file bundle, this one keeps external `assets/` references, which is
 * fine here: shared-assets mode targets pages served over http(s), which
 * never hits the `file://` module-script CORS restriction the default
 * bundle exists to avoid (see `packages/trace-viewer/vite.standalone.config.ts`).
 *
 * `fs.cp`'s recursive copy merges into an existing `destDir` rather than
 * nesting under it, so staging is safe to repeat across multiple exports
 * pointed at the same shared directory.
 *
 * Returns `'missing'` (without throwing) when the CLI install doesn't have
 * the bundled assets — e.g. a dev checkout where `copy:resources` hasn't run
 * — so the caller can warn instead of failing the export outright.
 */
export async function stageCliHistoryTraceViewerAssets(params: {
  readonly resourcesPath: string;
  readonly destDir: string;
}): Promise<'staged' | 'missing'> {
  const assetsSrc = path.join(
    params.resourcesPath,
    TRACE_VIEWER_SHARED_DIR_NAME,
  );
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
}): Promise<CliHistoryDeleteResult> {
  if (options.all) {
    const result = await deleteAllExecutions();
    await GoalStore.forgetByExecutionIds(result.deleted);
    return {
      deleted: 'all',
      count: result.deleted.length,
      active: result.active,
      failed: result.failed,
    };
  }
  if (!options.id) {
    throw new Error('Expected an execution id, or --all.');
  }
  const result = await deleteExecution(options.id);
  if (result.status === 'deleted') {
    await GoalStore.forgetByExecutionIds([options.id]);
  }
  return {
    deleted: 'one',
    id: options.id,
    found: result.status !== 'not-found',
    status: result.status,
  };
}

/**
 * `texra history delete --all` is destructive and unrecoverable. The command
 * handler must call this first: if `--all` is set without `--yes`, it should
 * refuse and quote the count back to the user; otherwise it can pass `count`
 * into the confirmation message before deletion.
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
  // Unlike list, a full wipe intentionally counts (and later clears) every
  // stored execution, including `isUserVisibleExecution`-hidden
  // process-bookkeeping entries and agent-spawned child runs — don't add the
  // visibility filter here.
  // (`show`/`export` were never filtered either — both are explicit-id
  // lookups, a different contract from browsing a list.)
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
        formatCliHistorySubject(entry, '-'),
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

/**
 * `--export ''` (or any non-`html`/`md` value) reports this. `JSON.stringify`
 * keeps the reported value unambiguous — an empty string reads as `""`
 * instead of collapsing into a confusing double space after the colon.
 */
export function formatInvalidExportFormatText(raw: string): string {
  return `Invalid export format: ${JSON.stringify(raw)} (use html or md)`;
}

/**
 * Frozen-NDJSON status projection (proposal gate G): the public NDJSON stream
 * keeps the pre-consolidation vocabulary — terminal outcomes emit as
 * `ExecutionStatus` ('completed' | 'interrupted' | 'error') while
 * 'resumable'/'unknown' pass through unchanged. Internal and human-readable
 * output keeps `HistoryRunStatus`.
 */
function toNdjsonHistoryStatus(status: string): string {
  const outcome = RunOutcomeSchema.safeParse(status);
  return outcome.success ? runOutcomeToExecutionStatus(outcome.data) : status;
}

export function cliHistoryNdjsonRecords(
  entries: readonly CliHistoryEntry[],
  ts = new Date().toISOString(),
): CliNdjsonRecord[] {
  return entries.map((entry) => ({
    kind: 'history-entry',
    ts,
    entry: { ...entry, status: toNdjsonHistoryStatus(entry.status) },
  }));
}

/** `history show`'s NDJSON record, with the frozen-boundary status projection. */
export function cliHistoryDetailNdjsonRecord(
  details: CliHistoryDetails,
): CliNdjsonRecord {
  return {
    kind: 'history-detail',
    detail: { ...details, status: toNdjsonHistoryStatus(details.status) },
  };
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

  if (teamPreset) lines.push(`Team: ${teamPreset}`);
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
  if (meta?.description) lines.push(`Description: ${meta.description}`);
  if (details.result) {
    lines.push(`Result: ${JSON.stringify(details.result)}`);
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
  if (details.hasFlowRecord) lines.push('', 'Flow record: present');
  return lines.join('\n');
}

async function toCliHistoryEntry(
  entry: AgentExecutionListingEntry,
): Promise<CliHistoryEntry> {
  const config = entry.record;
  const inputBasename = firstInputBasename(config);
  const resumability = await deriveResumability(entry.id);
  const resumeData = resumability.resumable
    ? await readCliToolUseResumeDataForListing(entry.id, config)
    : null;
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    agent: config.agent,
    model: resumeData?.agentConfig.model ?? config.model,
    status: resolveHistoryRunStatus({
      resumable: resumeData !== null,
      outcome: entry.outcome,
    }),
    inputBasename,
    category: config.agentCategory,
    description: entry.description,
    teamPresetId: teamPresetId(config),
    parentExecutionId: entry.parentExecutionId,
  };
}

function teamPresetId(config: AgentConfig | null): string | undefined {
  return config?.cliMultiAgentPresetId?.trim() || undefined;
}

function firstInputBasename(config: AgentConfig): string {
  const first = config.inputFiles.at(0);
  return first ? path.basename(first) : '-';
}
