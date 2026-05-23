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
import type { AgentConfig } from '@agent/core/AgentConfig';
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

const KV_FILES = new Set([
  'meta.json',
  'config.json',
  'conversation.json',
  'todos.json',
  'report.json',
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
  readonly files: readonly CliHistoryFile[];
  readonly hasFlowRecord: boolean;
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
  const [meta, config, resultMeta, report, files, hasFlowRecord] =
    await Promise.all([
      store.readMeta(),
      store.readConfig(),
      store.readResultMeta(),
      store.readReport(),
      listGeneratedFiles(id),
      store.exists(flowKey(id)),
    ]);

  if (!meta && !config && !hasFlowRecord) return null;
  return {
    id,
    meta,
    config,
    resultMeta,
    report,
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
