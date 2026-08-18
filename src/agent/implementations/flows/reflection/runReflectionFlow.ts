import { getExecutionStore } from '@agent/storage';
import type { StageHandle } from '@agent/trace';
import { PromptBuilder } from '@agent/prompt/PromptBuilder';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import { activeModelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { userRequestTemplateCount } from '@agent/index/agentYamlScanner';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import {
  PersistedFlowStateError,
  readPersistedFlowRecord,
  stampCompatibilityKey,
} from '@agent/node/persistedFlow';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import {
  type AgentFileLocation,
  type RetryErrorInfo,
  type RoundOutput,
  type RunOutcome,
  type StorageKey,
  type FileLocation,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  WORKFLOW_DOCUMENT_OUTPUT_EXT,
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { LatexDiffManager } from './output/LatexDiffManager';
import { XmlOutputManager } from './output/XmlOutputManager';
import {
  createOutputState,
  setActiveRun,
  getOutputFilesByRound,
  roundsFromPersisted,
} from './output/outputState';

import { TeXCountNode } from './nodes/TeXCountNode';
import { MediaExtractionNode } from './nodes/MediaExtractionNode';
import { PrepareContextNode } from './nodes/PrepareContextNode';
import { ResponseCycleNode } from './nodes/ResponseCycleNode';
import { OutputNode } from './nodes/OutputNode';
import {
  ReflectionFlowStateSchema,
  type ReflectionFlowShared,
} from './ReflectionFlowState';
import { RoundPersistedFlow } from './RoundPersistedFlow';
import type {
  ReflectionServices,
  WorkflowOutputPolicy,
} from './ReflectionServices';

/**
 * Widen a round stage's `total` for a granted compile-repair round (#7077):
 * that round opens with `roundIndex === totalRounds` (one past the
 * configured last round), so without this the progress badge would render
 * an over-total "Round 3 of 2".
 */
export function computeRoundStageTotal(
  totalRounds: number,
  roundIndex: number,
): number {
  return Math.max(totalRounds, roundIndex + 1);
}

export interface RunReflectionFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentWorkflowSetting;
  storageKey: StorageKey;
  parentStage: StageHandle;
}

export interface RunReflectionFlowResult {
  roundOutputs: RoundOutput[];
  outcome: RunOutcome;
  totalCostUsd?: number;
  /**
   * The structured provider error behind a FAILED outcome. The run reports its
   * failure here rather than by throwing, so the rounds it did produce travel
   * with it.
   */
  error?: RetryErrorInfo;
}

export async function runReflectionFlow<C = unknown>(
  input: RunReflectionFlowInput<C>,
): Promise<RunReflectionFlowResult> {
  const {
    modelCell,
    config,
    setting,
    prompt,
    logger,
    storageKey,
    parentStage,
    userVarChannels,
    runScope,
  } = input;
  const { streamId, executionId } = runScope;

  let shared: ReflectionFlowShared | undefined;

  const fileService = new TaskRunFileService(executionId);
  const compatibilityKey = activeModelHandlerCompatibilityKey(
    modelCell.handler,
  );

  const baseFiles: FileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : config.inputFiles
  ).map((file) => fileService.locateSource(file));

  const outputState = createOutputState();
  const xmlManager = new XmlOutputManager(
    config,
    logger,
    fileService,
    streamId,
  );
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
    userVarChannels.transient,
    logger,
  );

  const latexMediaManager = new LatexMediaManager(logger, fileService);

  const totalRounds = Math.max(
    setting.rounds ?? 2,
    userRequestTemplateCount(prompt.userRequest),
  );

  const getOutputFileLocation = async (
    round: number,
  ): Promise<AgentFileLocation> => {
    const canonical = fileService.createLocation(
      workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round }),
    ) as AgentFileLocation;
    // Resume-from-pre-refactor compat: if a round was partially written on an
    // older build that used `.tex` for non-scratchpad agents, keep using that
    // file on resume so initializeOutputAndPrefill sees the existing content
    // instead of starting a fresh round at output.xml.
    if (!(await AbsoluteFS.exists(canonical.absolutePath))) {
      const legacy = fileService.createLocation(
        workflowOutputPath({ ext: WORKFLOW_DOCUMENT_OUTPUT_EXT, round }),
      ) as AgentFileLocation;
      if (await AbsoluteFS.exists(legacy.absolutePath)) {
        return legacy;
      }
    }
    return canonical;
  };

  const workflowOutputPolicy: WorkflowOutputPolicy = {
    shouldAutoOpenPdfOrLog: () =>
      readPlatformSetting<boolean>(WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF),
    shouldRejectOnCompileFailure: () =>
      readPlatformSetting<boolean>(
        WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
      ),
  };

  const services: ReflectionServices<C> = {
    ...input,
    outputState,
    xmlManager,
    diffManager,
    latexMediaManager,
    promptBuilder,
    fileService,
    getOutputFileLocation,
    workflowOutputPolicy,
    baseFiles,
  };

  // Kick off run-workspace preparation (awaited lazily by extractFilesFromXml).
  setActiveRun(outputState, services, storageKey);

  const kv = getExecutionStore(executionId);

  const flowRecord = await readPersistedFlowRecord(kv, executionId);

  if (flowRecord) {
    // Validate the freshly-read persisted record before it enters the live
    // flow. `RoundPersistedFlow` revalidates later writes against the same
    // canonical schema.
    const validated = ReflectionFlowStateSchema.safeParse(flowRecord.shared);
    if (!validated.success) {
      throw new PersistedFlowStateError(executionId, 'invalid-shared', {
        cause: validated.error,
      });
    }

    shared = validated.data;
    // A keyless legacy record gets the active handler's key stamped here;
    // model-based inference for such records lives at SessionResumeRetrieval.
    shared = stampCompatibilityKey(shared, compatibilityKey);
    // Response-cycle cancellation persists a WAITING cursor together with
    // this latch. It records why the previous invocation stopped, not a
    // durable instruction that all later invocations must also stop.
    if (!shared.continueRounds && !shared.lastError) {
      shared.continueRounds = true;
    }
    // Always sync totalRounds from the current agent config so that changes
    // to the YAML (e.g. rounds: 2 → 1) take effect on resume.
    shared.totalRounds = totalRounds;
    logger.debug(
      `Resuming reflection flow from round ${shared.currentRound}/${shared.totalRounds}`,
    );
  } else {
    shared = {
      currentRound: 0,
      totalRounds,
      workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
      context: null,
      outputLocation: null,
      conversation: [],
      modelHandlerCompatibilityKey: compatibilityKey,
      runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
    };
  }

  // Hydrate the canonical live collection from the persisted round snapshot.
  outputState.rounds = roundsFromPersisted(shared.roundOutputs);

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
    ReflectionServices<C>
  >(prepContextNode, kv, {
    parentStage,
    sharedSchema: ReflectionFlowStateSchema,
    callbacks: {
      createRoundStage: (roundIndex, parent, shared) =>
        logger.openStage(`r${roundIndex}`, {
          parent: parent ?? undefined,
          kind: 'round',
          index: roundIndex,
          total: computeRoundStageTotal(shared.totalRounds, roundIndex),
        }),
      resetForNextRound: (s) => {
        s.workspaceSnapshot = AgentWorkspaceState.emptySnapshot();
      },
      signal: runScope.signal,
      // Bounded compile-repair round (#7077): a compile failure on what
      // would otherwise be the final round gets exactly one extra round
      // so the model sees the failure context via PrepareContextNode
      // instead of the run silently ending on a broken output. Gated on
      // the same setting that produced compileFailureContext in the
      // first place, and on the one-shot `compileRepairRoundGranted`
      // flag so a repair round that itself fails to compile doesn't
      // chain a second one — even across resume.
      grantExtraRound: (s) => {
        if (
          !s.compileFailureContext ||
          s.compileRepairRoundGranted ||
          !workflowOutputPolicy.shouldRejectOnCompileFailure()
        ) {
          return false;
        }
        s.compileRepairRoundGranted = true;
        return true;
      },
    },
  });

  pf.setServices(services);

  if (flowRecord) {
    logger.debug('Resuming reflection flow from persistence');
    // Resume runs from the flow-record conversation. Pre-sidecar sessions
    // once had that conversation imported into the transcript sidecar here;
    // the importer was retired per #9590 Stage 7, so such a session's
    // pre-resume turns stay out of the durable transcript.
    // Persist the synced totalRounds into the flow record so that
    // stepWithResult() picks up the current config, not the stale one.
    await pf.setShared(shared);
  }

  const outcome = await pf.run(shared);
  shared = await pf.getShared();

  const totalCostUsd =
    shared?.runStateSnapshot.usageAccumulator.totals.totalCost ?? 0;

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    outcome,
    ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
    ...(shared?.lastError ? { error: shared.lastError } : {}),
  };
}
