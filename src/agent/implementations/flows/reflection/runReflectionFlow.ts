import { getExecutionStore } from '@agent/storage';
import type { StageHandle } from '@agent/trace';
import { PromptBuilder } from '@agent/prompt/PromptBuilder';
import type {
  BaseFlowContextInit,
  ToolPolicy,
} from '@agent/core/flows/BaseFlowServices';
import { activeModelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
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
  type FileLocation,
  MESSAGE_TYPES,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { LatexDiffManager } from './output/LatexDiffManager';
import { XmlOutputManager } from './output/XmlOutputManager';
import {
  createOutputState,
  collectRunSupportFiles,
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

export interface RunReflectionFlowInput extends BaseFlowContextInit {
  setting: AgentWorkflowSetting;
  parentStage: StageHandle;
}

/**
 * Resolve workflow tool declarations at flow startup so a workflow advertises
 * the registry-owned contract, just like a tool-use flow.
 * Models without function calling receive no tool definitions, matching the
 * reflection flow's former model-facing capability gate.
 */
async function resolveWorkflowSettingTools(
  setting: AgentWorkflowSetting,
  toolPolicy: ToolPolicy,
  logger: { warn: (msg: string) => void },
  supportsFunctionCalling: boolean,
): Promise<AgentWorkflowSetting> {
  const { tools } = await resolveAgentTools({
    tools: setting.tools,
    logger,
    approvalPromptsUnavailable: toolPolicy.approvalPromptsUnavailable,
    runtimeUnavailableTools: toolPolicy.runtimeUnavailableTools,
    // Workflow agents do not use the tool-use flow's conditional infrastructure.
    toolInjections: new ToolInjectionRegistry(),
  });
  return { ...setting, tools: supportsFunctionCalling ? tools : [] };
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

export async function runReflectionFlow(
  input: RunReflectionFlowInput,
): Promise<RunReflectionFlowResult> {
  const {
    modelCell,
    config,
    setting,
    prompt,
    logger,
    parentStage,
    userVarChannels,
    runScope,
  } = input;
  const { streamId, executionId } = runScope;
  const resolvedSetting = await resolveWorkflowSettingTools(
    setting,
    input.toolPolicy,
    logger,
    modelCell.handler.capabilities?.supportsFunctionCalling === true,
  );

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
  ): Promise<AgentFileLocation> =>
    fileService.createLocation(
      workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round }),
    ) as AgentFileLocation;

  const workflowOutputPolicy: WorkflowOutputPolicy = {
    shouldAutoOpenPdfOrLog: () =>
      readPlatformSetting<boolean>(WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF),
    shouldRejectOnCompileFailure: () =>
      readPlatformSetting<boolean>(
        WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
      ),
  };

  const services: ReflectionServices = {
    ...input,
    setting: resolvedSetting,
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
  // Handle failure here too: a response can fail or be cancelled before output
  // extraction reaches the promise, and leaving it rejected would both hide the
  // filesystem failure and trigger an unhandled rejection.
  outputState.runPreparation = fileService
    .prepareRunWorkspace(baseFiles, {
      linkFiles: collectRunSupportFiles(services.config),
    })
    .catch((error) => {
      logger.warn(
        `Failed to prepare run workspace; in-place diffs may be empty: ${toErrorMessage(error)}`,
        {
          data: error,
          messageType: MESSAGE_TYPES.INTERNAL,
        },
      );
    });

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
      modelHandlerCompatibilityKey: compatibilityKey,
      runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
      roundOutputs: [],
      continueRounds: true,
      endTurn: false,
    };
  }

  // Hydrate the canonical live collection from the persisted round snapshot.
  outputState.rounds = roundsFromPersisted(shared.roundOutputs);

  const prepContextNode = new PrepareContextNode();
  const texCountNode = new TeXCountNode();
  const mediaNode = new MediaExtractionNode();
  const responseCycleNode = new ResponseCycleNode();
  const outputNode = new OutputNode();

  prepContextNode.next(texCountNode);
  texCountNode.next(mediaNode);
  mediaNode.next(responseCycleNode);
  responseCycleNode.next(outputNode);

  const pf = new RoundPersistedFlow<ReflectionFlowShared, ReflectionServices>(
    prepContextNode,
    kv,
    {
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
    },
  );

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
