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
import { projectRunOutcome } from '@common/constants/streamStatus';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  ExecutionStatusSchema,
  type ExecutionStatus,
  type RunOutcome,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { GoalStore } from '@tools/goal';

import { getAllActiveExecutionIds, type SessionHandle } from './SessionHandle';

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

export type RuntimeHistoryDeleteExecutionResult =
  | { readonly status: 'deleted' }
  | { readonly status: 'missing' }
  | { readonly status: 'running' };

export type RuntimeHistoryTerminalStatusRepairResult =
  | {
      readonly status: 'written';
      readonly terminalStatus: ExecutionStatus;
    }
  | {
      readonly status: 'preserved';
      readonly terminalStatus: string;
    };

export interface RuntimeHistoryTerminalStatusRequest {
  readonly executionId: ExecutionId;
  readonly outcome: RunOutcome;
}

export interface RuntimeWorkflowResultArtifacts {
  readonly outputs: NonNullable<ResultMeta['outputs']>;
  readonly compileFailures: NonNullable<ResultMeta['compileFailures']>;
  readonly copiedOutput?: string;
  readonly copiedOutputs?: readonly string[];
}

export interface RuntimeHistoryCommandOptions {
  readonly session?: SessionHandle;
  readonly activeExecutionIds?: readonly ExecutionId[];
}

export interface RuntimeHistoryClearResult {
  readonly deletedExecutionIds: readonly ExecutionId[];
  readonly activeExecutionIds: readonly ExecutionId[];
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
  const [
    meta,
    rawConfig,
    resultMeta,
    report,
    conversation,
    workspaceFilePaths,
  ] = await Promise.all([
    store.readMeta(),
    store.readConfig(),
    store.readResultMeta(),
    store.readReport(),
    store.readConversation(),
    store.readWorkspaceFiles(),
  ]);
  const config = rawConfig ? AgentConfigSchema.parse(rawConfig) : null;
  return {
    meta,
    config,
    resultMeta,
    report,
    conversation,
    workspaceFilePaths,
  };
}

async function readRuntimeHistoryTerminalStatus(
  executionId: ExecutionId,
): Promise<string | undefined> {
  return (await getExecutionStore(executionId).readMeta())?.terminalStatus;
}

export async function resolveRuntimeHistoryTerminalStatus({
  executionId,
  outcome,
}: RuntimeHistoryTerminalStatusRequest): Promise<ExecutionStatus> {
  const terminalStatus = await readRuntimeHistoryTerminalStatus(
    executionId,
  ).catch(() => undefined);
  const parsedTerminalStatus = ExecutionStatusSchema.safeParse(terminalStatus);
  if (parsedTerminalStatus.success) return parsedTerminalStatus.data;
  return projectRunOutcome(outcome).executionStatus;
}

function writeRuntimeHistoryTerminalStatus(
  executionId: ExecutionId,
  status: ExecutionStatus,
): Promise<void> {
  return writeTerminalStatus(executionId, status);
}

export function markRuntimeHistoryExecutionErrored(
  executionId: ExecutionId,
): Promise<void> {
  return writeRuntimeHistoryTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
}

export function markRuntimeHistoryExecutionInterrupted(
  executionId: ExecutionId,
): Promise<void> {
  return writeRuntimeHistoryTerminalStatus(
    executionId,
    EXECUTION_STATUS.INTERRUPTED,
  );
}

/**
 * Fill a missing terminal status for a registered execution without
 * overwriting the canonical terminal fact when the run lifecycle already wrote
 * it. This is the launch-boundary compensation for failures that happen after
 * execution-id allocation but before normal lifecycle finalization.
 */
export async function repairRuntimeHistoryTerminalStatus(
  executionId: ExecutionId,
  terminalStatus: ExecutionStatus = EXECUTION_STATUS.ERROR,
): Promise<RuntimeHistoryTerminalStatusRepairResult> {
  const existing = await readRuntimeHistoryTerminalStatus(executionId);
  if (existing !== undefined) {
    return { status: 'preserved', terminalStatus: existing };
  }

  await writeRuntimeHistoryTerminalStatus(executionId, terminalStatus);
  return { status: 'written', terminalStatus };
}

export function recordRuntimeWorkflowResultArtifacts(
  executionId: ExecutionId,
  artifacts: RuntimeWorkflowResultArtifacts,
): Promise<void> {
  const resultMeta: RuntimeHistoryResultMeta = {
    outputs: [...artifacts.outputs],
    compileFailures: [...artifacts.compileFailures],
  };
  if (artifacts.copiedOutput) {
    resultMeta.copiedOutput = artifacts.copiedOutput;
  }
  if (artifacts.copiedOutputs?.length) {
    resultMeta.copiedOutputs = [...artifacts.copiedOutputs];
  }
  return getExecutionStore(executionId).writeResultMeta(resultMeta);
}

export function listRuntimeHistoryWorkspaceFiles(
  config: RuntimeHistoryAgentConfig | null,
  filePaths: readonly string[],
): Promise<RuntimeHistoryWorkspaceFile[]> {
  return listExecutionWorkspaceFiles(config, filePaths);
}

export function readRuntimeHistoryWorkspaceFilePaths(
  executionId: ExecutionId,
): Promise<string[]> {
  return getExecutionStore(executionId).readWorkspaceFiles();
}

export async function readRuntimeHistoryConfig(
  executionId: ExecutionId,
): Promise<RuntimeHistoryAgentConfig | null> {
  const raw = await getExecutionStore(executionId).readConfig();
  return raw ? AgentConfigSchema.parse(raw) : null;
}

export async function requestDeleteRuntimeHistoryExecution(
  executionId: ExecutionId,
  options: RuntimeHistoryCommandOptions = {},
): Promise<RuntimeHistoryDeleteExecutionResult> {
  const activeExecutionIds = getRuntimeHistoryActiveExecutionIds(options);
  if (activeExecutionIds.includes(executionId)) {
    return { status: 'running' };
  }

  const deleted = await deleteExecution(executionId);
  if (deleted) {
    await GoalStore.forgetByExecutionIds([executionId]);
  }
  return { status: deleted ? 'deleted' : 'missing' };
}

export async function requestClearRuntimeHistoryExecutions({
  ...options
}: RuntimeHistoryCommandOptions = {}): Promise<RuntimeHistoryClearResult> {
  const activeExecutionIds = getRuntimeHistoryActiveExecutionIds(options);
  const deletedExecutionIds = await deleteAllExecutions(
    new Set(activeExecutionIds),
  );
  if (deletedExecutionIds.length > 0) {
    await GoalStore.forgetByExecutionIds(deletedExecutionIds);
  }
  return { deletedExecutionIds, activeExecutionIds };
}

function getRuntimeHistoryActiveExecutionIds({
  activeExecutionIds,
  session,
}: RuntimeHistoryCommandOptions): ExecutionId[] {
  if (activeExecutionIds) return [...activeExecutionIds];
  if (session) return session.executions.getActiveIds() as ExecutionId[];
  return getAllActiveExecutionIds() as ExecutionId[];
}
