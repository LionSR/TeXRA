import * as path from 'path';

import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type EndGroupStatus,
  type ExecutionStatus,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import { getExecutionStore } from '@agent/storage';
import {
  createOutputState,
  setActiveRun,
  getOutputFilesByRound,
} from '@agent/output/outputState';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import {
  registerInterruptible,
  unregisterInterruptible,
  type IInterruptible,
} from '@agent/toolUse/ToolUseAgentRegistry';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { isRoundAtOrBeyondLimit } from '@agent/node/round-bounds';
import type { FlowRecord } from '@agent/node/persisted-flow';
import { executionToEndStatus } from '@common/constants/streamStatus';
import type { UsageMonitor } from '@agent/utils/UsageMonitor';
import type { AgentLogStage } from '@logger/AgentLogger';
import {
  TaskRunFileService,
  WorkspaceFS,
  createWorkspaceLocation,
  type AgentFileLocation,
  type WorkspaceFileLocation,
} from '@utils/files';
import { PromptBuilder } from '@utils/prompt';
import { LatexMediaManager } from '@latex';

import { executeReflectionRound } from './reflectionRoundPipeline';
import {
  ReflectionFlowStateSchema,
  type ReflectionFlowShared,
} from './ReflectionFlowState';
import type { ReflectionServices } from './ReflectionServices';

export interface RunReflectionFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentWorkflowSetting;
  storageKey: StorageKey;
  parentStage: AgentLogStage;
  getOutputFileLocation?: (round: number) => AgentFileLocation;
  usageMonitor?: UsageMonitor;
  onRoundCompleted?: (roundIndex: number, totalRounds: number) => void;
}

export interface RunReflectionFlowResult {
  roundOutputs: RoundOutput[];
  status: EndGroupStatus;
}

function deriveConfig(
  setting: AgentWorkflowSetting,
  prompt: RunReflectionFlowInput['prompt'],
): {
  useScratchpad: boolean;
  shouldEnsureXmlStructure: boolean;
  totalRounds: number;
  outputExt: string;
} {
  const useScratchpad = setting.prefills.includes('<scratchpad>');

  let shouldEnsureXmlStructure: boolean;
  switch (setting.xmlStructureMode) {
    case 'always':
      shouldEnsureXmlStructure = true;
      break;
    case 'never':
      shouldEnsureXmlStructure = false;
      break;
    case 'scratchpadOnly':
      shouldEnsureXmlStructure = useScratchpad;
      break;
    default: {
      const _exhaustive: never = setting.xmlStructureMode;
      throw new Error(`Unknown xmlStructureMode: ${_exhaustive}`);
    }
  }

  const { userRequest } = prompt;
  let requestCount = 0;
  if (Array.isArray(userRequest)) {
    requestCount = userRequest.length;
  } else if (userRequest) {
    requestCount = 1;
  }
  const totalRounds = Math.max(setting.rounds ?? 2, requestCount);

  return {
    useScratchpad,
    shouldEnsureXmlStructure,
    totalRounds,
    outputExt: useScratchpad ? 'xml' : setting.outputExt,
  };
}

export async function runReflectionFlow<C = unknown>(
  input: RunReflectionFlowInput<C>,
): Promise<RunReflectionFlowResult> {
  const {
    modelHandler,
    config,
    setting,
    prompt,
    logger,
    streamId,
    executionId,
    storageKey,
    parentStage,
    userVarChannels,
    checkInterruption,
    onRoundFinalized = async () => {},
    usageMonitor,
  } = input;

  let status: EndGroupStatus = END_GROUP_STATUS.STOPPED;
  let shared: ReflectionFlowShared | undefined;

  const fileService = new TaskRunFileService(executionId);

  const baseFiles: WorkspaceFileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : [config.inputFile]
  ).map((f) => {
    const absolutePath = path.isAbsolute(f) ? f : WorkspaceFS.fullPath(f);
    const relativePath = path.isAbsolute(f) ? WorkspaceFS.relativePath(f) : f;
    return createWorkspaceLocation(absolutePath, relativePath);
  });

  const outputState = createOutputState();
  const xmlManager = new XmlOutputManager(setting, config, logger, fileService);
  const diffManager = new LatexDiffManager(
    setting,
    () => getOutputFilesByRound(outputState),
    baseFiles,
    logger,
    streamId,
    fileService,
  );

  const promptBuilder = new PromptBuilder(
    prompt,
    setting,
    userVarChannels.transient,
    logger,
  );

  const latexMediaManager = new LatexMediaManager(logger, fileService);

  const { useScratchpad, shouldEnsureXmlStructure, totalRounds, outputExt } =
    deriveConfig(setting, prompt);

  const modelName = modelHandler.config.name;
  const getOutputFileLocation =
    input.getOutputFileLocation ??
    ((round: number): AgentFileLocation => {
      const fileName = getOutputFileName(
        config.inputFile,
        config.agent,
        modelName,
        outputExt,
        round,
        config.editedFile || undefined,
      );
      if (useScratchpad) {
        return fileService.createRawOutputLocation(
          fileName,
        ) as AgentFileLocation;
      }
      return fileService.createLocation(fileName) as AgentFileLocation;
    });

  const interruptible: IInterruptible = {
    interrupt(): void {
      input.onInterrupt?.();
      retryCoordinator.clearRequest(streamId);
    },
  };

  setActiveRun(
    outputState,
    { setting, config, baseFiles, logger, fileService, executionId, streamId },
    storageKey,
  );

  const kv = getExecutionStore(executionId);

  const services: ReflectionServices<C> = {
    ...input,
    onRoundFinalized,
    outputState,
    xmlManager,
    diffManager,
    latexMediaManager,
    promptBuilder,
    fileService,
    getOutputFileLocation,
    shouldEnsureXmlStructure,
    baseFiles,
  };

  try {
    registerInterruptible(streamId, interruptible);

    // --- Resume or create fresh shared state ---
    const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
    const validated = flowRecord?.shared
      ? ReflectionFlowStateSchema.safeParse(flowRecord.shared)
      : null;

    if (validated?.success) {
      shared = validated.data as ReflectionFlowShared;
      // Always sync totalRounds from the current agent config so that changes
      // to the YAML (e.g. rounds: 2 → 1) take effect on resume.
      shared.totalRounds = totalRounds;
      logger.debug(
        `Resuming reflection flow from round ${shared.currentRound}/${shared.totalRounds}`,
      );
    }

    if (!shared) {
      shared = {
        currentRound: 0,
        totalRounds,
        workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
        context: null,
        outputLocation: null,
        conversation: [],
        runStateSnapshot: createRunState(),
        roundStateSnapshots: [],
        roundOutputs: [],
        continueRounds: true,
        endTurn: false,
      };
    }

    // Persist initial state so hasPersistedFlowRecord() can detect this flow
    if (!flowRecord) {
      await kv.write(`flow:${executionId}`, {
        flowName: 'texra',
        params: {},
        shared: structuredClone(shared),
        createdAt: new Date().toISOString(),
        nodes: [],
      } satisfies FlowRecord);
    }

    // --- Round loop (replaces RoundPersistedFlow + 5 node classes) ---
    let executionStatus: ExecutionStatus = EXECUTION_STATUS.COMPLETED;

    while (true) {
      // Create round stage for logging
      const roundStage: AgentLogStage = await logger.stage(
        `r${shared.currentRound}`,
        { parent: parentStage ?? undefined },
      );
      usageMonitor?.setActiveGroupId(roundStage.id);

      try {
        await roundStage.within(() =>
          executeReflectionRound(shared!, services),
        );
      } finally {
        roundStage.end();
      }

      // Checkpoint at round boundary
      await kv.write(`flow:${executionId}`, {
        flowName: 'texra',
        params: {},
        shared: structuredClone(shared),
        createdAt: new Date().toISOString(),
        nodes: [],
      } satisfies FlowRecord);

      // Decide whether to continue
      if (shared.lastError) {
        executionStatus = EXECUTION_STATUS.ERROR;
        break;
      }
      if (checkInterruption() || !shared.continueRounds) {
        executionStatus = EXECUTION_STATUS.INTERRUPTED;
        break;
      }
      if (
        isRoundAtOrBeyondLimit(shared.currentRound + 1, shared.totalRounds)
      ) {
        // All rounds complete
        input.onRoundCompleted?.(shared.currentRound, shared.totalRounds);
        break;
      }

      // Transition to next round
      input.onRoundCompleted?.(shared.currentRound, shared.totalRounds);
      shared.currentRound += 1;
      shared.workspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
    }

    if (shared.lastError) {
      status = END_GROUP_STATUS.ERROR;
      // Re-throw after state persistence (handled in finally) so
      // runFlowWithLifecycle logs the error and shows the user notification.
      throw new Error(shared.lastError.message);
    } else {
      status = executionToEndStatus(executionStatus) as EndGroupStatus;
    }
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Persist conversation regardless of success or failure so that
    // the executions tool can always show what happened before a crash.
    try {
      if (shared?.conversation?.length) {
        await kv.write('conversation', shared.conversation);
      }
    } catch {
      // Best-effort — don't mask the original error
    }

    if (status === END_GROUP_STATUS.STOPPED) {
      try {
        await kv.delete(`flow:${executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    retryCoordinator.clearRequest(streamId);

    unregisterInterruptible(streamId);
  }

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
