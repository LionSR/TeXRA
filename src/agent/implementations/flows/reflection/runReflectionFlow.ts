import * as path from 'path';

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
import { planApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { RoundPersistedFlow } from '@agent/node/roundPersistedFlow';
import type { UsageMonitor } from '@agent/utils/UsageMonitor';
import { executionToEndStatus } from '@common/constants/streamStatus';
import { LatexMediaManager } from '@latex';
import type { AgentLogStage } from '@logger/AgentLogger';
import {
  END_GROUP_STATUS,
  type EndGroupStatus,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import {
  TaskRunFileService,
  WorkspaceFS,
  createWorkspaceLocation,
  type AgentFileLocation,
  type WorkspaceFileLocation,
} from '@utils/files';
import { PromptBuilder } from '@utils/prompt';

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

export interface RunReflectionFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentWorkflowSetting;
  storageKey: StorageKey;
  parentStage: AgentLogStage;
  getOutputFileLocation?: (round: number) => AgentFileLocation;
  usageMonitor?: UsageMonitor;
  onRoundCompleted?: (roundIndex: number, totalRounds: number) => void;
  /** When true, outputs are routed to task-run storage by default. */
  isSubagent?: boolean;
}

export interface RunReflectionFlowResult {
  roundOutputs: RoundOutput[];
  status: EndGroupStatus;
}

function deriveConfig(
  setting: AgentWorkflowSetting,
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

  const totalRounds = setting.rounds ?? 2;

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
  let services: ReflectionServices<C> | undefined;

  const fileService = new TaskRunFileService(executionId, {
    forceRunStorage: input.isSubagent,
  });

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
    deriveConfig(setting);

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
      planApprovalCoordinator.clearForStream(streamId);
    },
  };

  setActiveRun(
    outputState,
    { setting, config, baseFiles, logger, fileService, executionId, streamId },
    storageKey,
  );

  const kv = getExecutionStore(executionId);

  try {
    registerInterruptible(streamId, interruptible);

    const flowRecord = await kv.read<FlowRecord>(flowKey(executionId));
    const validated = flowRecord?.shared
      ? ReflectionFlowStateSchema.safeParse(flowRecord.shared)
      : null;
    const isResume = validated?.success ?? false;

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
        workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
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
          s.workspaceSnapshot = AgentWorkspaceState.emptySnapshot();
        },
        checkInterruption,
        onRoundCompleted: (roundIndex, s) => {
          input.onRoundCompleted?.(roundIndex, s.totalRounds);
        },
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
    pf.setProjection(async (s, store) => {
      if (s.conversation?.length) await store.writeConversation(s.conversation);
    });

    if (isResume) {
      logger.debug('Resuming reflection flow from persistence');
      // Persist the synced totalRounds into the flow record so that
      // stepWithResult() picks up the current config, not the stale one.
      await pf.setShared(shared);
    }

    const flowStatus = await pf.run(shared);
    shared = await pf.getShared();

    if (shared?.lastError) {
      status = END_GROUP_STATUS.ERROR;
      // Re-throw so runFlowWithLifecycle logs the error and shows
      // the user notification. State was already projected per-step.
      throw new Error(shared.lastError.message);
    } else {
      status = executionToEndStatus(flowStatus) as EndGroupStatus;
    }
  } catch (error) {
    status = END_GROUP_STATUS.ERROR;
    throw error;
  } finally {
    if (status === END_GROUP_STATUS.STOPPED) {
      try {
        await kv.delete(flowKey(executionId));
      } catch {
        // Ignore cleanup errors
      }
    }

    retryCoordinator.clearRequest(streamId);
    planApprovalCoordinator.clearForStream(streamId);

    unregisterInterruptible(streamId);
  }

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
