import * as path from 'node:path';

import { getExecutionStore } from '@agent/storage';
import type { StageHandle } from '@agent/trace';
import {
  createOutputState,
  setActiveRun,
  getOutputFilesByRound,
} from '@agent/output/outputState';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import {
  interruptRegistry,
  type IInterruptible,
} from '@agent/runtime/InterruptRegistry';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { RoundPersistedFlow } from '@agent/node/roundPersistedFlow';
import {
  WORKFLOW_DOCUMENT_OUTPUT_EXT,
  WORKFLOW_RAW_OUTPUT_EXT,
} from '@agent/output/workflowOutputLayout';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import {
  END_GROUP_STATUS,
  RUN_OUTCOME,
  type AgentFileLocation,
  type EndGroupStatus,
  type RoundOutput,
  type RunOutcome,
  type StorageKey,
  type WorkspaceFileLocation,
} from '@shared/schemas';
import {
  AbsoluteFS,
  TaskRunFileService,
  WorkspaceFS,
  createWorkspaceLocation,
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
  parentStage: StageHandle;
  getOutputFileLocation?: (round: number) => AgentFileLocation;
  onRoundCompleted?: (
    roundIndex: number,
    totalRounds: number,
    outputPaths: readonly string[],
  ) => void;
}

export interface RunReflectionFlowResult {
  roundOutputs: RoundOutput[];
  outcome: RunOutcome;
  totalCostUsd?: number;
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
    runtimeHost,
    streamId,
    executionId,
    storageKey,
    parentStage,
    userVarChannels,
    checkInterruption,
    onRoundFinalized = async () => {},
  } = input;

  let outcome: RunOutcome = RUN_OUTCOME.CANCELLED;
  let shared: ReflectionFlowShared | undefined;
  let services: ReflectionServices<C> | undefined;

  const fileService = new TaskRunFileService(executionId);

  const baseFiles: WorkspaceFileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : config.inputFiles
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

  let requestCount: number;
  if (Array.isArray(prompt.userRequest)) {
    requestCount = prompt.userRequest.length;
  } else {
    requestCount = prompt.userRequest ? 1 : 0;
  }
  const totalRounds = Math.max(setting.rounds ?? 2, requestCount);

  const getOutputFileLocation =
    input.getOutputFileLocation ??
    ((round: number): AgentFileLocation => {
      // The default `r{round}/output.xml` filename is only collision-safe
      // when resolved through a run-storage-bound fileService. Enforce the
      // invariant so a misconfigured TaskRunFileService can't silently
      // route outputs to a shared `<workspace>/r{round}/output.xml` path.
      if (!fileService.hasRunDirectory()) {
        throw new Error(
          'runReflectionFlow requires a TaskRunFileService bound to an executionId for default output-path resolution.',
        );
      }
      const canonical = fileService.createLocation(
        getOutputFileName(WORKFLOW_RAW_OUTPUT_EXT, round),
      ) as AgentFileLocation;
      // Resume-from-pre-refactor compat: if a round was partially written on an
      // older build that used `.tex` for non-scratchpad agents, keep using that
      // file on resume so initializeOutputAndPrefill sees the existing content
      // instead of starting a fresh round at output.xml.
      if (!AbsoluteFS.existsSync(canonical.absolutePath)) {
        const legacy = fileService.createLocation(
          getOutputFileName(WORKFLOW_DOCUMENT_OUTPUT_EXT, round),
        ) as AgentFileLocation;
        if (AbsoluteFS.existsSync(legacy.absolutePath)) {
          return legacy;
        }
      }
      return canonical;
    });

  const interruptible: IInterruptible = {
    interrupt(): void {
      input.onInterrupt?.();
      runCoordinatorBridge.clearRetryRequest(streamId);
      runCoordinatorBridge.clearPlanApprovalForStream(streamId);
    },
  };

  setActiveRun(
    outputState,
    {
      setting,
      config,
      baseFiles,
      logger,
      fileService,
      executionId,
      streamId,
      runtimeHost,
    },
    storageKey,
  );

  const kv = getExecutionStore(executionId);

  try {
    interruptRegistry.register(streamId, interruptible);

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
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
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
          logger.openStage(`r${roundIndex}`, {
            parent: parent ?? undefined,
          }),
        resetForNextRound: (s) => {
          s.workspaceSnapshot = AgentWorkspaceState.emptySnapshot();
        },
        checkInterruption,
        onRoundCompleted: (roundIndex, s) => {
          const outputs = outputState.rounds.get(roundIndex)?.outputs ?? [];
          const outputPaths = outputs.map((o) =>
            'relativePath' in o.location
              ? o.location.relativePath
              : o.location.absolutePath,
          );
          input.onRoundCompleted?.(roundIndex, s.totalRounds, outputPaths);
        },
      },
    });

    services = {
      ...input,
      runtimeHost,
      onRoundFinalized,
      outputState,
      xmlManager,
      diffManager,
      latexMediaManager,
      promptBuilder,
      fileService,
      getOutputFileLocation,
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

    const flowOutcome = await pf.run(shared);
    shared = await pf.getShared();

    if (shared?.lastError) {
      outcome = RUN_OUTCOME.FAILED;
      // Re-throw so runFlowWithLifecycle logs the error and shows
      // the user notification. State was already projected per-step.
      throw new Error(shared.lastError.message);
    } else {
      outcome = flowOutcome;
    }
  } catch (error) {
    outcome = RUN_OUTCOME.FAILED;
    throw error;
  } finally {
    if (outcome === RUN_OUTCOME.COMPLETED) {
      try {
        await kv.delete(flowKey(executionId));
      } catch {
        // Ignore cleanup errors
      }
    }

    runCoordinatorBridge.clearRetryRequest(streamId);
    runCoordinatorBridge.clearPlanApprovalForStream(streamId);

    interruptRegistry.unregister(streamId);
  }

  const totalCostUsd =
    shared?.runStateSnapshot.usageAccumulator.totals.totalCost ?? 0;

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    outcome,
    ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
  };
}
