/**
 * Reflection round pipeline — replaces the 5 outer node classes
 * (PrepareContextNode, TeXCountNode, MediaExtractionNode, ResponseCycleNode, OutputNode)
 * with a single async function.
 *
 * The inner ResponseCycleFlow (model invocation, tool dispatch, continuation)
 * is still a proper node graph — only the outer orchestration is flattened.
 */

import { recordRound } from '@agent/core/AgentState';
import { createRoundState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '@agent/core/flows/ResponseCycleFlow';
import { buildCycleServices } from '@agent/core/flows/CycleServices';
import type { RoundFileMapping } from '@agent/output/types';
import { hasRoundOutputs, getStorageKey } from '@agent/output/outputState';
import { extractFilesFromXml } from '@agent/output/xmlExtraction';
import { traceFileLineage } from '@agent/output/lineageMapping';
import { checkExpectedOutputs } from '@agent/output/outputValidation';
import {
  summarizeRound,
  getRoundOutput,
  type RoundSummary,
} from '@agent/output/roundSummary';
import { formatProviderHttpError, toErrorMessage } from '@common/errors';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { getTeXCountStats } from '@latex';
import { bus } from '@eventBus/ProgressEventBus';
import { flexibleFS } from '@utils/files';
import type { RoundOutput } from '@shared/schemas';

import { getFilesForRound } from './helpers';
import type { ReflectionFlowShared } from './ReflectionFlowState';
import type { ReflectionServices } from './ReflectionServices';

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Execute a single reflection round. Inlines the logic previously spread
 * across PrepareContextNode → TeXCountNode → MediaExtractionNode →
 * ResponseCycleNode → OutputNode.
 *
 * Mutates `shared` in place (same contract as the old nodes).
 */
export async function executeReflectionRound<C = unknown>(
  shared: ReflectionFlowShared,
  services: ReflectionServices<C>,
): Promise<void> {
  // === 1. Prepare context (was PrepareContextNode) ========================
  await prepareContext(shared, services);

  // === 2. TeX count (was TeXCountNode) ====================================
  await attachTeXCount(shared, services);

  // === 3. Media extraction (was MediaExtractionNode) ======================
  await extractMedia(shared, services);

  // === 4. Response cycle (was ResponseCycleNode) ==========================
  const cycleOk = await runResponseCycle(shared, services);

  // === 5. Output processing (was OutputNode) ==============================
  // Always runs — when the cycle failed, endTurn is false so processing is
  // skipped but a summary stub is still generated.
  if (cycleOk) {
    await processOutput(shared, services);
  } else {
    // Cycle failed or was cancelled — still record a minimal round output
    await processOutput(shared, services);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Prepare context
// ---------------------------------------------------------------------------

async function prepareContext<C>(
  shared: ReflectionFlowShared,
  services: ReflectionServices<C>,
): Promise<void> {
  const { promptBuilder, modelHandler, logger } = services;
  const { currentRound, conversation } = shared;

  const stateRound = createRoundState(currentRound);
  const isFirstRound = currentRound === 0;

  let messages;
  if (isFirstRound) {
    const { systemPrompt, userRequest, userPrefix } =
      await promptBuilder.buildInitialPrompts();
    messages = await modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemPrompt,
    );
  } else {
    messages = await modelHandler.createRoundMessages(
      conversation,
      await promptBuilder.buildUserRequest(currentRound),
      undefined,
    );
  }

  const prefill = await promptBuilder.buildPrefill(currentRound);

  logger.debug(
    `Prepared ${isFirstRound ? 'first' : `round ${currentRound}`} context with ${messages.length} messages`,
  );

  shared.context = {
    messages,
    prefill: prefill ?? '',
    stateRoundSnapshot: stateRound,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Attach TeX count
// ---------------------------------------------------------------------------

async function attachTeXCount<C>(
  shared: ReflectionFlowShared,
  services: ReflectionServices<C>,
): Promise<void> {
  const { config, fileService, modelHandler, logger } = services;

  if (!config.toolConfig.attachTeXCount) return;

  const files = getFilesForRound(
    shared.currentRound,
    shared.roundOutputs,
    config,
    fileService,
  );
  if (files.length === 0) return;

  try {
    const stats = await getTeXCountStats(
      files.map((f) => f.absolutePath),
    );
    if (stats && shared.context) {
      modelHandler.prependTextToUserMessage(shared.context.messages, stats);
    }
  } catch (error) {
    logger.debug(
      `TeXCount skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 3: Extract media
// ---------------------------------------------------------------------------

async function extractMedia<C>(
  shared: ReflectionFlowShared,
  services: ReflectionServices<C>,
): Promise<void> {
  const { modelHandler, latexMediaManager, config, fileService, logger } =
    services;

  if (!modelHandler.capabilities.supportsVision) return;

  const files = getFilesForRound(
    shared.currentRound,
    shared.roundOutputs,
    config,
    fileService,
  );
  if (files.length === 0) return;

  const workspaceState = AgentWorkspaceState.fromSnapshot(
    shared.workspaceSnapshot,
  );

  try {
    const extraMediaFiles = [];
    if (shared.currentRound === 0) {
      if (config.mediaFile) {
        extraMediaFiles.push(fileService.createLocation(config.mediaFile));
      }
      extraMediaFiles.push(
        ...config.mediaFiles.map((p) => fileService.createLocation(p)),
      );
      await latexMediaManager.processInputFiles(
        files,
        workspaceState,
        config.toolConfig,
        true,
        extraMediaFiles,
      );
    } else {
      await latexMediaManager.processOutputFiles(
        files,
        workspaceState,
        config.toolConfig,
        true,
      );
    }

    const mediaFiles = workspaceState.media.files;
    if (mediaFiles.length > 0 && shared.context) {
      await modelHandler.addMediaToUserMessage(
        shared.context.messages,
        mediaFiles,
      );
    }
  } catch (error) {
    logger.debug(
      `Media extraction skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Always snapshot back — even on error the workspace may have partial state
  shared.workspaceSnapshot = workspaceState.toSnapshot();
}

// ---------------------------------------------------------------------------
// Step 4: Run response cycle
// ---------------------------------------------------------------------------

/**
 * Returns true if the cycle completed or was cancelled (output step should run).
 * Returns false only if a fatal error means we should skip output entirely —
 * but currently we always proceed to output (matching old OutputNode behavior).
 */
async function runResponseCycle<C>(
  shared: ReflectionFlowShared,
  services: ReflectionServices<C>,
): Promise<boolean> {
  const { modelHandler, config, setting, logger } = services;
  const context = shared.context;

  if (!context) {
    throw new Error('Context not prepared — prepareContext must run first');
  }

  const workspace = AgentWorkspaceState.fromSnapshot(shared.workspaceSnapshot);
  const run = shared.runStateSnapshot;
  const round = context.stateRoundSnapshot;
  const outputLocation = services.getOutputFileLocation(shared.currentRound);

  shared.outputLocation = outputLocation;

  try {
    const [prefillEndsTurn, initializedMessages] =
      await modelHandler.initializeOutputAndPrefill(
        config,
        setting,
        context.messages,
        workspace,
        outputLocation,
        context.prefill,
      );

    if (prefillEndsTurn) {
      shared.endTurn = true;
      shared.lastError = undefined;
      shared.runStateSnapshot = run;
      shared.workspaceSnapshot = workspace.toSnapshot();
      shared.conversation = context.messages;
      shared.roundStateSnapshots.push(context.stateRoundSnapshot);
      return true;
    }

    const cycleShared: ResponseCycleShared = {
      messages: initializedMessages,
      outputLocation,
      endTurn: false,
      shouldStop: false,
      outputExists: false,
    };

    const flow = createResponseCycleFlow<C>();
    flow.setServices(
      await buildCycleServices(services, { round, run, workspace }),
    );
    await flow.run(cycleShared);

    // Interpret cycle outcome
    if (cycleShared.lastError) {
      logger.error(`Response cycle failed: ${cycleShared.lastError.message}`);
      shared.lastError = {
        message: cycleShared.lastError.message,
        retryable: cycleShared.lastError.retryable ?? false,
      };
      shared.continueRounds = false;
      shared.endTurn = false;
      return true; // still run output step
    }

    if (cycleShared.shouldStop && !cycleShared.endTurn) {
      // User cancelled
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      shared.endTurn = false;
      shared.lastError = undefined;
      return true;
    }

    // Successful completion
    shared.endTurn = cycleShared.endTurn;
    shared.lastError = undefined;
    shared.runStateSnapshot = run;
    shared.workspaceSnapshot = workspace.toSnapshot();
    shared.conversation = context.messages;
    shared.roundStateSnapshots.push(context.stateRoundSnapshot);
    return true;
  } catch (error) {
    // Record round even on error (matches old execFallback behavior)
    recordRound(run, round);
    if (services.onRoundFinalized) {
      await services.onRoundFinalized(run);
    }
    const formatted = formatProviderHttpError(error);
    shared.lastError = {
      message: error instanceof Error ? error.message : String(error),
      retryable: formatted.retryable ?? false,
    };
    shared.continueRounds = false;
    shared.endTurn = false;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Step 5: Process output
// ---------------------------------------------------------------------------

/** Execute an operation that can fail gracefully (logs warnings, doesn't throw). */
async function tryOperation(
  label: string,
  operation: () => Promise<void>,
  logger: { warn: (msg: string) => void },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    logger.warn(`${label} failed: ${toErrorMessage(error)}`);
  }
}

async function processOutput<C>(
  shared: ReflectionFlowShared,
  services: ReflectionServices<C>,
): Promise<void> {
  const {
    outputState,
    xmlManager,
    diffManager,
    setting,
    logger,
    baseFiles,
    shouldEnsureXmlStructure: shouldEnsureXml,
    streamId,
  } = services;

  const outputLocation = shared.outputLocation;
  if (!outputLocation) {
    throw new Error(
      'Output location not set — runResponseCycle must run first',
    );
  }

  const { currentRound } = shared;
  const { endTurn } = shared;

  let mapping: RoundFileMapping | undefined;
  let roundOutput: RoundOutput;
  let summary: RoundSummary;

  try {
    // Only process if turn ended (model completed response)
    if (endTurn) {
      logger.debug(`Processing output for round ${currentRound}`);

      if (shouldEnsureXml) {
        await tryOperation(
          'XML structure',
          () =>
            xmlManager.ensureCorrectXmlStructure(
              outputLocation,
              setting.documentTag,
            ),
          logger,
        );
      }

      await tryOperation(
        'Output processing',
        () =>
          extractFilesFromXml(
            outputState,
            services,
            xmlManager,
            outputLocation,
            currentRound,
          ),
        logger,
      );

      if (hasRoundOutputs(outputState, currentRound)) {
        mapping = traceFileLineage(outputState, baseFiles, currentRound);

        await tryOperation(
          'Latexdiff',
          async () => {
            const existingBase = await Promise.all(
              baseFiles.map((f) => flexibleFS.exists(f)),
            );
            if (!existingBase.some(Boolean)) {
              logger.debug('No base files found for latexdiff');
              return;
            }
            await diffManager.handleLatexdiffofOutput(currentRound, mapping!);
          },
          logger,
        );
      }
    }

    summary = await summarizeRound(outputState, services, outputLocation, currentRound, {
      endTurn,
      mapping,
      isRewrite: setting.isRewrite,
    });

    roundOutput = await getRoundOutput(outputState, baseFiles, currentRound, {
      isRewrite: setting.isRewrite,
    });
  } catch (error) {
    // Fallback — still produce a summary stub (matches old execFallback)
    logger.warn(
      `Output processing failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    try {
      summary = await summarizeRound(
        outputState,
        services,
        outputLocation,
        currentRound,
        { endTurn, isRewrite: setting.isRewrite },
      );
    } catch {
      summary = {
        storageKey: getStorageKey(outputState),
        currRound: currentRound,
        fileInfos: [],
        filesToOpen: [],
        outputFile: outputLocation,
        endTurn,
      };
    }

    roundOutput = {
      round: currentRound,
      rawOutput: null,
      outputs: [],
      xmlSummary: {
        tagContents: {},
        documents: [],
        singleOutputFile: null,
        sourceLocation: null,
      },
    };
  }

  // --- Side effects (post) ---

  bus.emit('addOutputFiles', {
    streamId,
    storageKey: summary.storageKey,
    filesByRound: { [currentRound]: summary.fileInfos },
  });

  for (const location of summary.filesToOpen) {
    await tryOperation(
      `Open file ${location.absolutePath}`,
      () => openBuildDisplayIfTex(location, { preserveFocus: true }),
      logger,
    );
  }

  if (endTurn) {
    await tryOperation(
      'Validate expected outputs',
      async () => {
        const validationResult = await checkExpectedOutputs(
          outputState,
          services,
          outputLocation,
          currentRound,
          summary.stage,
        );

        bus.emit('updateMissingOutputs', {
          streamId,
          storageKey: validationResult.storageKey,
          filesByRound: { [currentRound]: validationResult.missing },
        });

        if (validationResult.missing.length > 0) {
          await showInstructionWithSuppress(
            'missingOutputsInfo',
            'Missing output files detected',
          );
        }
      },
      logger,
    );
  }

  shared.roundOutputs[currentRound] = roundOutput;
}
