/**
 * runReflectionFlow - Entry point for reflection flow execution.
 *
 * Executes workflow-style agents that run for a fixed number of rounds,
 * producing structured output. Behavior is configuration-driven:
 * - Total rounds = max(setting.rounds, userRequest.length)
 * - `setting.xmlStructureMode`: 'never' | 'scratchpadOnly' | 'always'
 */

import * as path from 'path';

import {
  END_GROUP_STATUS,
  type EndGroupStatus,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import { executionToEndStatus } from '@common/constants/streamStatus';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
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
import type { FlowRecord } from '@agent/node/persisted-flow';
import { RoundPersistedFlow } from '@agent/node/round-persisted-flow';
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

import { TeXCountNode } from './nodes/TeXCountNode';
import { MediaExtractionNode } from './nodes/MediaExtractionNode';
import { PrepareContextNode } from './nodes/PrepareContextNode';
import { ResponseCycleNode } from './nodes/ResponseCycleNode';
import { OutputNode } from './nodes/OutputNode';
import {
  ReflectionFlowStateSchema,
  type ReflectionFlowShared,
} from './ReflectionFlowState';
import type { ReflectionServices } from './ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for running a reflection flow.
 * Extends BaseFlowContextInit with reflection-specific fields.
 */
export interface RunReflectionFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Narrow setting to workflow-specific type */
  setting: AgentWorkflowSetting;

  /** Storage key for file organization (computed by caller). */
  storageKey: StorageKey;

  /** Parent log stage for creating round stages. */
  parentStage: AgentLogStage;

  /** Optional custom output file location getter (used by merge). */
  getOutputFileLocation?: (round: number) => AgentFileLocation;

  /** Usage monitor for tracking round statistics. */
  usageMonitor?: UsageMonitor;
}

/**
 * Result from running a reflection flow.
 */
export interface RunReflectionFlowResult {
  /** Round outputs from the flow execution */
  roundOutputs: RoundOutput[];

  /** Status of the flow execution */
  status: EndGroupStatus;
}

// ============================================================================
// Configuration Derivation
// ============================================================================

/** Derive configuration values from settings and prompts. */
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

  // Determine if XML structure enforcement is needed
  const xmlMode = setting.xmlStructureMode;
  let shouldEnsureXmlStructure: boolean;
  switch (xmlMode) {
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
      const _exhaustive: never = xmlMode;
      throw new Error(`Unknown xmlStructureMode: ${_exhaustive}`);
    }
  }

  // Compute total rounds: max(setting.rounds, userRequest count)
  const { userRequest } = prompt;
  let requestCount = 0;
  if (Array.isArray(userRequest)) requestCount = userRequest.length;
  else if (userRequest) requestCount = 1;
  const totalRounds = Math.max(setting.rounds ?? 2, requestCount);

  return {
    useScratchpad,
    shouldEnsureXmlStructure,
    totalRounds,
    outputExt: useScratchpad ? 'xml' : setting.outputExt,
  };
}

// ============================================================================
// Flow Runner
// ============================================================================

/** Run a reflection flow. Creates services and manages interrupt registration. */
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
  let services: ReflectionServices<C> | undefined;

  const fileService = new TaskRunFileService(executionId);

  // Create workspace file locations for latexdiff base files
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

  // Create output file location getter
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

  try {
    // Register for interrupt handling
    registerInterruptible(streamId, interruptible);

    const kv = getExecutionStore(executionId);

    // Try to restore full state from persisted flow (resume scenario)
    const flowRecord = await kv.read<FlowRecord>(`flow:${executionId}`);
    const validated = flowRecord?.shared
      ? ReflectionFlowStateSchema.safeParse(flowRecord.shared)
      : null;
    const isResume = validated?.success ?? false;

    if (validated?.success) {
      shared = validated.data as ReflectionFlowShared;
      logger.debug(
        `Resuming reflection flow from round ${shared.currentRound}/${shared.totalRounds}`,
      );
    }

    // Create fresh state if not resuming
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

    // Wire the linear node chain: prep → texcount → media → cycle → output
    const prepContextNode = new PrepareContextNode<C>();
    const texCountNode = new TeXCountNode<C>();
    const mediaNode = new MediaExtractionNode<C>();
    const responseCycleNode = new ResponseCycleNode<C>();
    const outputNode = new OutputNode<C>();

    prepContextNode.next(texCountNode);
    texCountNode.next(mediaNode);
    mediaNode.next(responseCycleNode);
    responseCycleNode.next(outputNode);

    const pf = new RoundPersistedFlow<
      ReflectionFlowShared,
      Record<string, unknown>,
      ReflectionServices<C>
    >(prepContextNode, kv, {
      parentStage,
      callbacks: {
        createRoundStage: (roundIndex, parent) =>
          logger.stage(`r${roundIndex}`, {
            parent: parent ?? undefined,
          }),
        onStageCreated: (stage) => {
          usageMonitor?.setActiveGroupId(stage.id);
        },
        resetForNextRound: (s) => {
          s.workspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
        },
        checkInterruption,
      },
    });

    services = {
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
    pf.setServices(services);

    if (isResume) {
      logger.debug('Resuming reflection flow from persistence');
    }

    const flowStatus = await pf.run(shared);
    shared = await pf.getShared();
    status = executionToEndStatus(flowStatus) as EndGroupStatus;
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    // Only delete flow record on successful completion
    // Keep it for interrupted/error flows to enable resume
    // Note: END_GROUP_STATUS.STOPPED means "completed" (not user-stopped)
    if (status === END_GROUP_STATUS.STOPPED) {
      try {
        const kv = getExecutionStore(executionId);
        await kv.delete(`flow:${executionId}`);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clean up retry coordinator
    retryCoordinator.clearRequest(streamId);

    unregisterInterruptible(streamId);
  }

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
