import {
  clearStoreCache,
  deleteAllExecutions,
  deleteExecution,
  getExecutionStore,
  listExecutionWorkspaceFiles,
  listExecutions,
  writeTerminalStatus,
  type ExecutionListingEntry,
  type ExecutionMeta,
  type ExecutionWorkspaceFile,
  type ResultMeta,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';

export type RuntimeHistoryAgentConfig = AgentConfig;
export type RuntimeHistoryExecutionMeta = ExecutionMeta;
export type RuntimeHistoryResultMeta = ResultMeta;
export type RuntimeHistoryWorkspaceFile = ExecutionWorkspaceFile;

export interface RuntimeHistoryExecutionEntry {
  readonly id: ExecutionId;
  readonly timestamp: string;
  readonly parentExecutionId?: ExecutionId;
  readonly delegationDepth?: number;
  readonly agent: string;
  readonly model: string;
  readonly agentConfig: RuntimeHistoryAgentConfig | null;
  readonly category?: string;
  readonly terminalStatus?: string;
  readonly description?: string;
}

export interface RuntimeHistoryExecutionRecord {
  readonly meta: RuntimeHistoryExecutionMeta | null;
  readonly config: RuntimeHistoryAgentConfig | null;
  readonly resultMeta: RuntimeHistoryResultMeta | null;
  readonly report: string | null;
  readonly conversation: unknown[] | null;
  readonly workspaceFilePaths: readonly string[];
}

function toRuntimeHistoryExecutionEntry(
  entry: ExecutionListingEntry,
): RuntimeHistoryExecutionEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    parentExecutionId: entry.parentExecutionId,
    delegationDepth: entry.delegationDepth,
    agent: entry.agent,
    model: entry.model,
    agentConfig: entry.agentConfig,
    category: entry.category,
    terminalStatus: entry.terminalStatus,
    description: entry.description,
  };
}

export function clearRuntimeHistoryStoreCache(): void {
  clearStoreCache();
}

export async function listRuntimeHistoryExecutions(): Promise<
  RuntimeHistoryExecutionEntry[]
> {
  return (await listExecutions()).map(toRuntimeHistoryExecutionEntry);
}

export async function countRuntimeHistoryExecutions(): Promise<number> {
  return (await listExecutions()).length;
}

export async function hasRuntimeExecutionHistory(): Promise<boolean> {
  return (await countRuntimeHistoryExecutions()) > 0;
}

export async function getRuntimeMostRecentSingleToolUseModel(): Promise<
  string | undefined
> {
  const entries = await listExecutions();
  const mostRecent = entries.find(
    (entry) =>
      entry.agentConfig?.agentCategory === AgentCategory.ToolUse &&
      !entry.agentConfig.cliMultiAgentPresetId,
  );
  return mostRecent?.agentConfig?.model;
}

export async function readRuntimeHistoryExecutionRecord(
  executionId: ExecutionId,
): Promise<RuntimeHistoryExecutionRecord> {
  const store = getExecutionStore(executionId);
  const [meta, config, resultMeta, report, conversation, workspaceFilePaths] =
    await Promise.all([
      store.readMeta(),
      store.readConfig(),
      store.readResultMeta(),
      store.readReport(),
      store.readConversation(),
      store.readWorkspaceFiles(),
    ]);
  return {
    meta,
    config,
    resultMeta,
    report,
    conversation,
    workspaceFilePaths,
  };
}

export async function readRuntimeHistoryTerminalStatus(
  executionId: ExecutionId,
): Promise<string | undefined> {
  return (await getExecutionStore(executionId).readMeta())?.terminalStatus;
}

export function writeRuntimeTerminalStatus(
  executionId: ExecutionId,
  status: string,
): Promise<void> {
  return writeTerminalStatus(executionId, status);
}

export function writeRuntimeHistoryResultMeta(
  executionId: ExecutionId,
  resultMeta: RuntimeHistoryResultMeta,
): Promise<void> {
  return getExecutionStore(executionId).writeResultMeta(resultMeta);
}

export function listRuntimeHistoryWorkspaceFiles(
  config: RuntimeHistoryAgentConfig | null,
  filePaths: readonly string[],
): Promise<RuntimeHistoryWorkspaceFile[]> {
  return listExecutionWorkspaceFiles(config, filePaths);
}

export async function readRuntimeHistoryConfig(
  executionId: ExecutionId,
): Promise<RuntimeHistoryAgentConfig | null> {
  const raw = await getExecutionStore(executionId).readConfig();
  return raw ? AgentConfigSchema.parse(raw) : null;
}

export function deleteRuntimeHistoryExecution(
  executionId: ExecutionId,
): Promise<boolean> {
  return deleteExecution(executionId);
}

export function deleteAllRuntimeHistoryExecutions(
  activeExecutionIds?: ReadonlySet<ExecutionId>,
): Promise<ExecutionId[]> {
  return deleteAllExecutions(activeExecutionIds);
}
