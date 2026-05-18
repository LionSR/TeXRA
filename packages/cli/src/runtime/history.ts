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
  | { readonly deleted: 'all' }
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
}): Promise<CliHistoryDeleteResult> {
  if (options.all) {
    await deleteAllExecutions();
    return { deleted: 'all' };
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

export function formatCliHistoryText(
  entries: readonly CliHistoryEntry[],
): string {
  return entries.map(formatCliHistoryLine).join('\n');
}

export function formatCliHistoryLine(entry: CliHistoryEntry): string {
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
  const config = details.config;
  const meta = details.meta;
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
  let entries: [string, number][];
  try {
    entries = await StorageFS.readDir(fullPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }

  const files: CliHistoryFile[] = [];
  for (const [name, type] of entries) {
    if (isHistoryKvFile(name)) continue;
    const rawRelative = relativePath ? path.join(relativePath, name) : name;
    const normalizedPath = rawRelative.replaceAll('\\', '/');
    const childPath = path.join(basePath, rawRelative);
    const entryIsDirectory = isDirectory(type);
    const stat = await StorageFS.stat(childPath).catch(() => ({ size: 0 }));
    files.push({
      path: normalizedPath,
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
