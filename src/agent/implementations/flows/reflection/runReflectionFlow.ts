/**
 * runReflectionFlow - Entry point for reflection flow execution.
 *
 * Executes workflow-style agents that run for a fixed number of rounds,
 * producing structured output. Behavior is configuration-driven:
 * - Total rounds = max(setting.rounds, userRequest.length)
 * - `setting.xmlStructureMode`: 'never' | 'scratchpadOnly' | 'always'
 *
 * The flow manages:
 * - Round progression and stage lifecycle
 * - Prompt building and output handling
 * - Interrupt handling and cleanup
 *
 * ## Koala-code-reader Pattern
 *
 * Following koala's approach:
 * - shared state is natively serializable (snapshots, not class instances)
 * - services contain runtime dependencies (parentStage, logger, etc.)
 * - PersistedFlow handles persistence transparently
 */

import * as path from 'path';

import {
  type EndGroupStatus,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import { Flow } from '@agent/node';
import {
  createOutputState,
  setActiveRun,
  getOutputFilesByRound,
  type OutputState,
} from '@agent/output/outputState';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import type { IInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';
import { retryCoordinator } from '@agent/runtime/RetryRequestCoordinator';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { AgentWorkflowSetting } from '@agent/core/AgentDataclass';
import { PersistedFlow } from '@agent/node/persisted-flow';
import { runWithRounds } from '@agent/node/round-runner';
import type { UsageMonitor } from '@agent/utils/UsageMonitor';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { executionToEndStatus } from '@common/constants/streamStatus';
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
import { runPersistedFlow } from '../common/runPersistedFlow';

import { TeXCountNode } from './nodes/TeXCountNode';
import { MediaExtractionNode } from './nodes/MediaExtractionNode';
import { PrepareContextNode } from './nodes/PrepareContextNode';
import { ResponseCycleNode } from './nodes/ResponseCycleNode';
import { OutputNode } from './nodes/OutputNode';
import { RoundCompleteNode } from './nodes/RoundCompleteNode';
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
  let requestCount: number;
  if (Array.isArray(userRequest)) {
    requestCount = userRequest.length;
  } else if (userRequest) {
    requestCount = 1;
  } else {
    requestCount = 0;
  }
  // Use fallback to handle edge cases where schema defaults may not apply
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

  let shared: ReflectionFlowShared | undefined;

  const fileService = new TaskRunFileService(executionId);

  // Create workspace file locations for latexdiff base files
  const baseFiles: WorkspaceFileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : [config.inputFile]
  ).map((f) => {
    const absolutePath = path.isAbsolute(f) ? f : WorkspaceFS.fullPath(f);
    const relativePath = path.isAbsolute(f) ? WorkspaceFS.relativePath(f) : f;
    return createWorkspaceLocation(absolutePath, relativePath);
  });

  // Create output state (deps are now derived from services via structural subtyping)
  const outputState: OutputState = createOutputState();
  // Create managers directly (no factory indirection)
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

  const status = await runPersistedFlow<ReflectionFlowShared>({
    ctx: { streamId, executionId, logger },
    interruptible,

    validateResume: (raw) => {
      const result = ReflectionFlowStateSchema.safeParse(raw);
      if (!result.success) return null;
      const parsed = result.data as ReflectionFlowShared;
      logger.debug(
        `Resuming reflection flow from round ${parsed.currentRound}/${parsed.totalRounds}`,
      );
      return parsed;
    },

    execute: async (resume) => {
      shared = resume.shared ?? {
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

      // Create flow nodes and wire transitions
      const prepContextNode = new PrepareContextNode<C>();
      const texCountNode = new TeXCountNode<C>();
      const mediaNode = new MediaExtractionNode<C>();
      const responseCycleNode = new ResponseCycleNode<C>();
      const outputNode = new OutputNode<C>();
      const roundCompleteNode = new RoundCompleteNode<C>();

      prepContextNode.next(texCountNode);
      texCountNode.next(mediaNode);
      mediaNode.next(responseCycleNode);
      responseCycleNode.next(outputNode);
      outputNode.next(roundCompleteNode);
      roundCompleteNode.on(FlowTransition.CONTINUE_NEXT_ROUND, prepContextNode);

      const pf = new PersistedFlow<
        ReflectionFlowShared,
        Record<string, unknown>,
        ReflectionServices<C>
      >(prepContextNode, resume.kv);

      pf.setServices({
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
      });

      if (resume.shared) {
        logger.debug('Resuming reflection flow from persistence');
      }

      const flowStatus = await runWithRounds(pf, shared, {
        parentStage,
        hooks: {
          createRoundStage: async (roundIndex, parent) => {
            return await logger.stage(`r${roundIndex}`, {
              parent: parent ?? undefined,
            });
          },
          onStageCreated: (stage) => {
            usageMonitor?.setActiveGroupId(stage.id);
          },
          resetForNextRound: (s) => {
            s.workspaceSnapshot = AgentWorkspaceState.create().toSnapshot();
          },
          checkInterruption,
        },
      });
      shared = await pf.getShared();
      return executionToEndStatus(flowStatus) as EndGroupStatus;
    },
  });

  return {
    roundOutputs: shared?.roundOutputs ?? [],
    status,
  };
}
