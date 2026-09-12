/**
 * The reflection program: the tool-use loop's shape with one outer
 * coordinate, the round. One plain Effect loop over the run ledger, no cursor
 * and no graph; every phase is row data and the loop continues from the state
 * each `appendBatch` returns, so the live path and the resume path are one
 * function.
 *
 * The write points, in order (manifest section 1.2): the opening snapshot of
 * a fresh run; per round the round prompt with its `model.ready` snapshot and
 * `round.begin`; per response cycle the invoker's `attempt` / `identified` /
 * `response` rows, then `response.processed` with the snapshot that either
 * admits a continuation or moves to `output.ready`; `output.pending` before
 * any file write; `round.end` with the snapshot of the next round or of the
 * finished run; and the `halted` step at every exit that ends the run.
 *
 * A turn the provider refused for exceeding its context window is recovered
 * once per round: the history is compacted (`model.compaction`) and the cycle
 * continues against it. A second overflow in the same round stops, and so does
 * a compaction that shortened nothing, because the same history would overflow
 * again.
 *
 * Reflection dispatches no tools: a turn advertises none, so a response never
 * carries a local call and the assistant message enters history with its
 * `response` row. That narrows the retired flow, which forwarded a workflow's
 * declared `setting.tools` to any model that supported function calling: this
 * program has no dispatch site, so advertising a tool would invite a call
 * nothing can settle. A workflow that needs tools runs in the tool-use
 * family, and the reflection run's tool registry is empty by construction.
 */
import { dirname } from 'node:path';
import { Cause, Effect, Exit, Ref, SynchronizedRef } from 'effect';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { userRequestTemplateCount } from '@agent/index/agentYamlScanner';
import {
  compileFailuresOf,
  runCompileCheck,
} from '@agent/implementations/flows/reflection/output/compileCheck';
import {
  appendCompileFailureRoundContext,
  formatCompileFailureRoundContext,
} from '@agent/implementations/flows/reflection/output/compileFailureRoundContext';
import { LatexDiffManager } from '@agent/implementations/flows/reflection/output/LatexDiffManager';
import { traceFileLineage } from '@agent/implementations/flows/reflection/output/lineageMapping';
import { extractFilesFromXml } from '@agent/implementations/flows/reflection/output/outputFileExtraction';
import { tryOperation } from '@agent/implementations/flows/reflection/output/outputOperations';
import {
  createOutputState,
  ensureRoundData,
  getCompileFailuresByRound,
  getOutputFilesByRound,
  roundsFromPersisted,
  roundsToPersisted,
  setCompileFailures,
  type OutputDependencies,
} from '@agent/implementations/flows/reflection/output/outputState';
import { checkExpectedOutputs } from '@agent/implementations/flows/reflection/output/outputValidation';
import {
  summarizeRound,
  type RoundSummary,
} from '@agent/implementations/flows/reflection/output/roundSummary';
import { resolveBaseFilesForDiff } from '@agent/implementations/flows/reflection/output/snapshotResolution';
import type { RoundFileMapping } from '@agent/implementations/flows/reflection/output/types';
import { XmlOutputManager } from '@agent/implementations/flows/reflection/output/XmlOutputManager';
import {
  getSystemPromptWithRules,
  PromptBuilder,
} from '@agent/prompt/PromptBuilder';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import { logUserMessage, type StageHandle } from '@agent/trace';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import { getTeXCountStats } from '@latex/texcount';
import {
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import {
  AgentCategory,
  AgentRunStateSnapshotSchema,
  EMPTY_RUN_USAGE_TOTALS,
  fileLocationDisplayPath,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  RUN_OUTCOME,
  SCRATCHPAD_TAG,
  type AgentFileLocation,
  type CompileResult,
  type FileLocation,
  type NormalizedUsage,
  type RetryErrorInfo,
  type RoundOutput,
  type RunOutcome,
  type RunStorageFileLocation,
  type RunUsageTotals,
} from '@shared/schemas';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import { freshRunState, type RunState } from '@shared/session/runStateFold';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { extractScratchpad } from '@utils/text/xmlExtraction';

import { AgentRun } from '../run/AgentRun';
import { compactIfNeeded } from '../run/compaction';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { ModelInvoker, turnText } from '../ModelInvoker';
import {
  appendRow,
  haltedStepRow,
  NOT_RESUMABLE_MESSAGE,
  reflectionFlowState,
  reflectionSnapshotRow,
  runtimeSnapshotRow,
  stepRow,
  type ReflectionFlowState,
  type ReflectionSnapshotPatch,
} from './rows';
import type { BoundModel } from '../run/modelBinding';

// Reflection owns conversation limits and document completion, not the provider.
/** Length for preview slices of tool output and responses. */
const K_SLICE = 200;
const CONTINUE_LIMIT = 10;
const INPUT_TOKEN_LIMIT = 1500000;
const OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

export interface ReflectionStart {
  /** The caller launched this as a resume; the ledger decides what it is. */
  readonly resume: boolean;
}

export interface ReflectionResult {
  readonly outcome: RunOutcome;
  readonly roundOutputs: RoundOutput[];
  readonly usage: RunUsageTotals;
  /**
   * Structured provider/runtime error behind a FAILED outcome, when present.
   * A rejected compile is an outcome-only domain failure whose diagnostics are
   * carried by roundOutputs instead.
   */
  readonly error?: RetryErrorInfo;
}

interface OutputExecResult {
  summary: RoundSummary;
  compileResult?: CompileResult;
  compiledArtifacts: RunStorageFileLocation[];
  emitCompileFailures: boolean;
}

type RoundExit = {
  readonly state: RunState;
  readonly kind: 'completed' | 'failed' | 'cancelled';
};

/** The finish reason of a completed turn; the editor arm reports none. */
function finishReasonOf(
  turn: NonNullable<RunState['lastTurn']>,
):
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'stop-sequence'
  | 'refusal'
  | 'context-window-exceeded' {
  return turn.kind === 'http' ? turn.finishReason : 'stop';
}

export const runReflection = Effect.fn('reflection.run')(function* (
  start: ReflectionStart,
): Effect.fn.Return<
  ReflectionResult,
  Error,
  AgentRun | RunLedger | ModelInvoker
> {
  const run = yield* AgentRun;
  const ledger = yield* RunLedger;
  const invoker = yield* ModelInvoker;
  const { runId, session, logger, config, prompt, fileService } = run;
  const setting = run.setting;
  if (setting.agentCategory !== AgentCategory.Workflow) {
    return yield* Effect.die(
      new Error('runReflection requires a workflow setting.'),
    );
  }

  // ------------------------------------------------------------ services
  const getRejectOnCompileFailure = () =>
    readPlatformSetting<boolean>(
      WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    );
  const baseFiles: FileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : config.inputFiles
  ).map((file) => fileService.locateSource(file));
  const outputState = createOutputState();
  const xmlManager = new XmlOutputManager(
    config,
    logger,
    fileService,
    outputState,
  );
  const diffManager = new LatexDiffManager(
    setting.isRewrite,
    () => getOutputFilesByRound(outputState),
    logger,
    runId,
    fileService,
  );
  const promptBuilder = new PromptBuilder(prompt, run.userVarChannels, logger);
  const latexMediaManager = new LatexMediaManager(logger, fileService);
  const totalRounds = Math.max(
    setting.rounds ?? 2,
    userRequestTemplateCount(prompt.userRequest),
  );
  const outputLocationFor = (round: number): AgentFileLocation =>
    fileService.createLocation(
      workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round }),
    ) as AgentFileLocation;
  const deps: OutputDependencies = {
    setting,
    config,
    baseFiles,
    logger,
    fileService,
  };
  const recoverWarn = (label: string) => ({
    logger,
    level: 'warn' as const,
    label,
    messageType: MESSAGE_TYPES.DEFAULT,
    recover: () => undefined,
  });

  // ---------------------------------------------------------------- state
  const latest = yield* Ref.make<RunState | null>(null);
  const commit = (state: RunState) =>
    Ref.set(latest, state).pipe(Effect.as(state));
  let workspace = AgentWorkspaceState.create();
  // The run's error fact, runtime-owned: every snapshot names it, so the
  // value a listing or a resume reads (`runtime.lastError`) is the value the
  // live loop holds, and a resumed run that retries clears it for good.
  let lastError: RetryErrorInfo | undefined;
  /**
   * One forced-compaction recovery per round: a turn that overflowed the
   * context window is retried once against a compacted history, and a second
   * overflow in the same round stops rather than paying for a futile retry.
   */
  let contextWindowRecoveryAttempted = false;
  // The scalar family state; the snapshot re-derives the collections below.
  let flow: ReflectionFlowState = {
    currentRound: 0,
    totalRounds,
    workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
    outputLocation: null,
    runStateSnapshot: { totalRounds, totalResponseTimeMs: 0 },
    roundOutputs: [],
    continueRounds: true,
    endTurn: false,
  };
  const flowState = (): ReflectionFlowState => ({
    ...flow,
    workspaceSnapshot: workspace.toSnapshot({ excludeAssemblyStrings: true }),
    roundOutputs: roundsToPersisted(outputState),
  });
  const snapshot = (
    state: RunState,
    patch: Omit<ReflectionSnapshotPatch, 'state'>,
  ) =>
    reflectionSnapshotRow(runId, state, {
      ...patch,
      runtime: { lastError: lastError ?? null, ...patch.runtime },
      state: flowState(),
    });
  const coordinates = (state: RunState, continuationIndex?: number) => ({
    family: state.family,
    round: flow.currentRound,
    turn: state.turn,
    continuationIndex: continuationIndex ?? state.continuationIndex,
  });
  const usageSnapshot = (
    state: RunState,
    latestUsage: NormalizedUsage | null,
  ) =>
    AgentRunStateSnapshotSchema.parse({
      totalRounds: flow.currentRound,
      totalResponseTimeMs: flow.runStateSnapshot.totalResponseTimeMs,
      usageAccumulator: { totals: state.usage, latestUsage },
    });

  /** Disabling rejection is an explicit acceptance decision. */
  const normalizeCompileRejectionPolicy = (): void => {
    if (
      getRejectOnCompileFailure() ||
      (!flow.unresolvedCompileRejection && !flow.compileFailureContext)
    ) {
      return;
    }
    delete flow.unresolvedCompileRejection;
    delete flow.compileFailureContext;
  };
  const terminalCompileRejection = (): boolean =>
    flow.unresolvedCompileRejection === true &&
    flow.currentRound + 1 >= flow.totalRounds;
  const resolveOutcome = (): RunOutcome =>
    deriveRunOutcome({
      failed: lastError !== undefined || terminalCompileRejection(),
      cancelled: false,
    });
  /** The round loop's single continue/finalize decision. */
  const shouldContinueNextRound = (): boolean =>
    lastError === undefined &&
    flow.continueRounds &&
    flow.currentRound + 1 < flow.totalRounds;

  /** The files a round works on: inputs first, then the previous outputs. */
  const filesForRound = (round: number): FileLocation[] => {
    if (round === 0) {
      return config.inputFiles.map((f) => fileService.createLocation(f));
    }
    const previous = flow.roundOutputs[round - 1];
    if (previous?.outputs.length) {
      return previous.outputs.map((o) => o.location);
    }
    return config.outputFiles.map((f) => fileService.createLocation(f));
  };

  const fresh = (bound: BoundModel): RunState => ({
    ...freshRunState(0),
    family: 'reflection',
    modelId: bound.modelId,
    modelCompatibilityKey: bound.compatibilityKey,
  });

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('reflection.open')(function* (): Effect.fn.Return<
    RunState,
    Error
  > {
    // A workflow YAML may still declare `tools:`. This family advertises
    // none (header), so the narrowing is stated rather than silent.
    if (setting.tools.length > 0) {
      const declared = setting.tools.map((tool) => tool.name).join(', ');
      logger.warn(
        `The workflow family advertises no tools under this release, so the tools resolved for this run are not offered to the model: ${declared}. Run the agent in the tool-use family if it needs them.`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
    }
    const bound = yield* SynchronizedRef.get(run.model);
    const opened = yield* ledger.appendBatch(runId, null, [
      reflectionSnapshotRow(runId, fresh(bound), {
        phase: 'round.ready',
        round: 0,
        runtime: {
          modelId: bound.modelId,
          modelCompatibilityKey: bound.compatibilityKey,
        },
        state: flowState(),
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return yield* commit(opened);
  });

  /** Restore the family state a resumed run continues from. */
  const restore = Effect.fn('reflection.restore')(function* (
    state: RunState,
  ): Effect.fn.Return<void, Error> {
    const persisted = reflectionFlowState(state);
    if (persisted === null) {
      return yield* Effect.fail(
        new Error(`Run ${runId} is not a reflection run; resume it as one.`),
      );
    }
    // The configured total wins over the persisted one, so a YAML change
    // (rounds: 2 -> 1) takes effect on resume; a resumed run retries the
    // invocation its failure interrupted rather than failing again at once.
    flow = { ...persisted, totalRounds };
    // The run's error fact resumes with it: the loop carries the durable
    // `lastError` forward so the next snapshot restates it, and only a
    // response that actually arrives clears it (below).
    lastError = state.lastError ?? undefined;
    workspace = AgentWorkspaceState.fromSnapshot(persisted.workspaceSnapshot);
    outputState.rounds = roundsFromPersisted(persisted.roundOutputs);
    // Mid-round, the raw output file holds the text every earlier response
    // cycle produced; the next connector and continuation prompt read its tail.
    if (
      persisted.outputLocation !== null &&
      (state.phase === 'model.ready' ||
        state.phase === 'model.submitted' ||
        state.phase === 'response.ready')
    ) {
      const path = persisted.outputLocation.absolutePath;
      const content = yield* Effect.tryPromise({
        try: async () =>
          (await AbsoluteFS.exists(path)) ? AbsoluteFS.read(path) : '',
        catch: ensureError,
      });
      workspace.assembly.accumulatedOutput = content;
      workspace.assembly.lastResponse = content;
    }
    logger.debug(
      `Resuming reflection run from round ${flow.currentRound}/${flow.totalRounds}`,
    );
  });

  // ----------------------------------------------------------- the round
  /** The round prompt, its media and TeX count, committed with `round.begin`. */
  const prepareRound = Effect.fn('reflection.prepareRound')(function* (
    initial: RunState,
  ): Effect.fn.Return<RunState, Error> {
    const round = flow.currentRound;
    const bound = yield* SynchronizedRef.get(run.model);
    contextWindowRecoveryAttempted = false;
    workspace = AgentWorkspaceState.create();
    flow = {
      ...flow,
      outputLocation: outputLocationFor(round),
      endTurn: false,
      rawOutputBytes: 0,
    };
    const files = filesForRound(round);
    const content: InputPart[] = [];

    if (config.toolConfig.attachTeXCount && files.length > 0) {
      const counted = yield* Effect.exit(
        getTeXCountStats(files.map((f) => f.absolutePath)),
      );
      if (Exit.isFailure(counted)) {
        if (Cause.hasInterrupts(counted.cause)) return yield* Effect.interrupt;
        logger.debug('TeXCount skipped', { data: Cause.squash(counted.cause) });
      } else if (counted.value) {
        content.push({ kind: 'text', text: counted.value });
      }
    }

    const prefixText: string[] = [];
    let requestText: string;
    if (round === 0) {
      const initialPrompts = yield* Effect.tryPromise({
        try: () => run.inScope(() => promptBuilder.buildInitialPrompts()),
        catch: ensureError,
      });
      if (initialPrompts.userPrefix.trim()) {
        prefixText.push(initialPrompts.userPrefix.trim());
      }
      requestText = initialPrompts.userRequest.trim();
    } else {
      const request = yield* Effect.tryPromise({
        try: () => run.inScope(() => promptBuilder.buildUserRequest(round)),
        catch: ensureError,
      });
      requestText = appendCompileFailureRoundContext(
        request,
        flow.compileFailureContext,
      ).trim();
      delete flow.compileFailureContext;
    }
    for (const text of prefixText) content.push({ kind: 'text', text });

    // Media: figures and PDFs of the round's files, plus the configured media
    // on the first round. Best effort, never silent: a skipped extraction
    // says so in the transcript; the opening row logs whether or not the
    // attachment succeeded.
    let attachmentKinds: readonly InputPart['kind'][] = [];
    if (bound.supportsVision && files.length > 0) {
      const extracted = yield* Effect.exit(
        round === 0
          ? latexMediaManager.processInputFiles(
              files,
              workspace,
              config.toolConfig,
              config.mediaFiles.map((p) => fileService.createLocation(p)),
            )
          : Effect.tryPromise({
              try: () =>
                run.inScope(() => fileService.ensureMirroredInRoundDir(round)),
              catch: ensureError,
            }).pipe(
              Effect.andThen(
                latexMediaManager.processOutputFiles(
                  files,
                  workspace,
                  config.toolConfig,
                ),
              ),
            ),
      );
      if (Exit.isFailure(extracted)) {
        if (Cause.hasInterrupts(extracted.cause))
          return yield* Effect.interrupt;
        logger.debug('Media extraction skipped', {
          data: Cause.squash(extracted.cause),
        });
      } else {
        const media = yield* Effect.exit(
          mediaInputParts(
            [...workspace.media.files],
            bound,
            logger,
            run.inScope,
          ),
        );
        if (Exit.isFailure(media)) {
          if (Cause.hasInterrupts(media.cause)) return yield* Effect.interrupt;
          logger.warn('Media attachment failed; continuing without it', {
            data: Cause.squash(media.cause),
          });
        } else {
          content.push(...media.value.parts);
          attachmentKinds = media.value.parts.map((part) => part.kind);
        }
      }
    }
    if (round === 0 && run.initialUserMessageForTranscript) {
      logUserMessage(
        logger,
        run.initialUserMessageForTranscript,
        attachmentKinds.flatMap((kind) =>
          kind === 'image' || kind === 'document' ? [kind] : [],
        ),
      );
    }
    if (requestText) content.push({ kind: 'text', text: requestText });
    if (content.length === 0) {
      return yield* Effect.fail(
        new Error(`Round ${round} has no prompt to send.`),
      );
    }
    logger.debug('Prepared round context', {
      data: { round, parts: content.length },
    });
    const prepared = yield* ledger.appendBatch(runId, initial, [
      appendRow(runId, [{ role: 'user', content }]),
      snapshot(initial, { phase: 'model.ready', round, continuationIndex: 0 }),
      stepRow(runId, coordinates(initial, 0), 'round.begin'),
    ]);
    return yield* commit(prepared);
  });

  /**
   * Append this cycle's text to the round's raw output file at the byte
   * offset the last processed response left. A replayed response completes
   * a partial write or skips one already complete; conflicting content is
   * rewritten from the offset and said so.
   */
  const writeOutputFragment = (
    location: AgentFileLocation,
    fragment: string,
  ): Effect.Effect<void, Error> =>
    Effect.tryPromise({
      try: () =>
        run.inScope(async () => {
          const path = location.absolutePath;
          const expected = flow.rawOutputBytes ?? 0;
          const fragmentBytes = Buffer.byteLength(fragment);
          await AbsoluteFS.ensureDir(dirname(path));
          const exists = await AbsoluteFS.exists(path);
          const actual = exists ? (await AbsoluteFS.stat(path)).size : 0;
          if (
            actual === expected + fragmentBytes &&
            expected + fragmentBytes > 0
          ) {
            logger.debug(
              'Raw output already holds this response; not appending twice.',
            );
          } else if (actual === expected) {
            if (exists) {
              logger.debug(`Appending to existing file: ${path}`);
              await AbsoluteFS.appendFile(path, fragment);
            } else {
              logger.debug(`Creating new file: ${path}`);
              await AbsoluteFS.write(path, fragment);
            }
          } else {
            logger.warn(
              `Raw output ${path} is ${actual} bytes where ${expected} were recorded; rewriting from the recorded offset.`,
            );
            const existing = exists
              ? await AbsoluteFS.readBytes(path)
              : Buffer.alloc(0);
            await AbsoluteFS.write(
              path,
              Buffer.concat([
                existing.subarray(0, Math.min(expected, existing.length)),
                Buffer.from(fragment),
              ]).toString('utf8'),
            );
          }
          flow = { ...flow, rawOutputBytes: expected + fragmentBytes };
        }),
      catch: ensureError,
    });

  /**
   * Process the committed response the state holds: write its text to the
   * raw output, then commit the next phase, a continuation with its prompt
   * or `output.ready`, together with `response.processed`.
   */
  const processResponse = Effect.fn('reflection.processResponse')(function* (
    initial: RunState,
  ): Effect.fn.Return<RunState, Error> {
    const turn = initial.lastTurn;
    const location = flow.outputLocation;
    if (turn === null || location === null) {
      return yield* Effect.die(
        new Error('A response is processed only after its row and its round.'),
      );
    }
    const finish = finishReasonOf(turn);
    let text = session.responseTextProcessing.postProcessResponse(
      turnText(turn),
    );
    // A provider stop sequence strips the tag it matched; restore it so
    // extraction sees the document it closed.
    if (finish === 'stop-sequence' && !text.includes(OUTPUT_END_TAG)) {
      text = `${text}\n${OUTPUT_END_TAG}`;
    }
    logger.debug(`Stop reason: ${finish}`);
    const scratchpad = yield* Effect.tryPromise({
      try: () => extractScratchpad(text, SCRATCHPAD_TAG),
      catch: ensureError,
    });
    if (scratchpad) {
      logger.info(scratchpad, { messageType: MESSAGE_TYPES.SCRATCHPAD });
    }

    let endTurn = false;
    let continueCycle = false;
    // The state the continuation is issued against: an overflow retry
    // replaces it with the compacted history the retry needs.
    let base = initial;
    // Set when this continuation is the overflow retry rather than a
    // response that was merely cut off.
    let retryingAfterCompaction = false;
    /**
     * A context-window overflow is recoverable once per round: force the
     * compaction the history needs and retry the cycle against it. A second
     * overflow, or a compaction that shortened nothing, stops, because the
     * same history would overflow again.
     */
    const admitOverflowRetry = Effect.fn('reflection.overflowRetry')(
      function* (): Effect.fn.Return<boolean, Error> {
        if (contextWindowRecoveryAttempted) {
          logger.warn(
            'Model context window still exceeded after forced compaction; stopping to avoid a futile retry.',
          );
          return false;
        }
        contextWindowRecoveryAttempted = true;
        const bound = yield* SynchronizedRef.get(run.model);
        // The retry pays for a summary first: the compaction row is committed
        // before the continuation prompt, so the retried request is issued
        // against the compacted history the fold returns.
        const compacted = yield* commit(
          yield* compactIfNeeded(base, {
            runId,
            ledger,
            logger,
            bound,
            system: undefined,
            tools: [],
            force: true,
          }),
        );
        if (compacted === base) {
          logger.warn(
            'Model context window exceeded and compaction shortened nothing; stopping to avoid a futile retry.',
          );
          return false;
        }
        base = compacted;
        retryingAfterCompaction = true;
        return true;
      },
    );
    if (text) {
      const connector =
        yield* session.responseTextProcessing.connectResponseText(
          workspace.assembly.lastResponse.slice(-K_SLICE),
          text.slice(0, K_SLICE),
        );
      yield* writeOutputFragment(
        location,
        workspace.assembly.accumulatedOutput ? connector + text : text,
      );
      workspace.assembly.lastResponse = text;
      workspace.assembly.accumulatedOutput += connector + text;
      logger.debug(`First ${K_SLICE} chars:\n${text.slice(0, K_SLICE)}`);
      logger.debug(`Last ${K_SLICE} chars:\n${text.slice(-K_SLICE)}`);

      const totals = initial.usage;
      const maxOutputTokens =
        totals.firstInputTokens > 0
          ? OUTPUT_TOKEN_LIMIT_FACTOR * totals.firstInputTokens
          : Number.POSITIVE_INFINITY;
      const continuationLimitExceeded =
        initial.continuationIndex > CONTINUE_LIMIT;
      const inputTokenLimitExceeded =
        totals.totalInputTokens > INPUT_TOKEN_LIMIT;
      const encounterDocumentTag = text.includes(OUTPUT_END_TAG);
      endTurn = finish === 'stop' || finish === 'stop-sequence';
      // Warn-only by design: this multiplier has never stopped a run, it
      // flags one whose output has run away relative to its first input.
      if (totals.totalOutputTokens > maxOutputTokens) {
        logger.warn('Output tokens exceed input token multiplier', {
          data: {
            maxOutputTokensFactor: OUTPUT_TOKEN_LIMIT_FACTOR,
            totalOutputTokens: totals.totalOutputTokens,
            firstInputTokens: totals.firstInputTokens,
          },
        });
      }
      const shouldStop =
        encounterDocumentTag ||
        continuationLimitExceeded ||
        inputTokenLimitExceeded;
      if (shouldStop) {
        logger.debug('StopFlags', {
          data: {
            endTurn,
            encounterDocumentTag,
            continuationLimitExceeded,
            inputTokenLimitExceeded,
          },
        });
      } else if (finish === 'context-window-exceeded') {
        continueCycle = yield* admitOverflowRetry();
      } else if (finish === 'length') {
        continueCycle = true;
      }
    } else if (finish === 'context-window-exceeded') {
      continueCycle = yield* admitOverflowRetry();
    }

    if (continueCycle) {
      const next = initial.continuationIndex + 1;
      logger.info(`Starting continuation #${next}`, {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      logger.info(
        retryingAfterCompaction
          ? 'Retrying after forcing model context compaction'
          : 'Continuing after hitting the model token limit',
        { messageType: MESSAGE_TYPES.PROGRESS_STATUS },
      );
      const prefillTokens = workspace.assembly.lastResponse.slice(-K_SLICE);
      const continuationPrompt = `Your response got cut off, because you only have limited response space. Continue responding exactly from where you left off until the very end, marked by ${OUTPUT_END_TAG}. Avoid repeating yourself and avoid starting over. Start your response at the next token after: "${prefillTokens}"`;
      flow = { ...flow, endTurn: false };
      const continued = yield* ledger.appendBatch(runId, base, [
        appendRow(runId, [
          {
            role: 'user',
            content: [{ kind: 'text', text: continuationPrompt }],
          },
        ]),
        snapshot(base, { phase: 'model.ready', continuationIndex: next }),
        stepRow(runId, coordinates(base, next), 'response.processed'),
      ]);
      return yield* commit(continued);
    }
    // `output.pending` is committed before any output file is touched, so
    // a re-entry at this phase knows the pipeline may have started.
    flow = { ...flow, endTurn };
    const processed = yield* ledger.appendBatch(runId, initial, [
      snapshot(initial, { phase: 'output.pending' }),
      stepRow(runId, coordinates(initial), 'response.processed'),
      stepRow(runId, coordinates(initial), 'output.ready'),
    ]);
    return yield* commit(processed);
  });

  /** The output pipeline over the round's raw output: extraction, lineage,
   *  latexdiff, the compile check, and the round summary. */
  const processOutput = async (
    round: number,
    outputLocation: AgentFileLocation,
    endTurn: boolean,
  ): Promise<OutputExecResult> => {
    const diffBaseFiles = await resolveBaseFilesForDiff(baseFiles, runId);
    let mapping: RoundFileMapping | undefined;
    let compileRoundResult: CompileResult | undefined;
    const compiledArtifacts: RunStorageFileLocation[] = [];
    let emitCompileFailures = false;
    if (endTurn) {
      logger.debug(`Processing output for round ${round}`);
      await tryOperation(
        () => xmlManager.ensureCorrectXmlStructure(outputLocation),
        recoverWarn('XML structure'),
      );
      await tryOperation(
        () =>
          extractFilesFromXml(
            outputState,
            deps,
            xmlManager,
            outputLocation,
            round,
          ),
        recoverWarn('Output processing'),
      );
      if ((outputState.rounds.get(round)?.outputs.length ?? 0) > 0) {
        mapping = traceFileLineage(outputState, diffBaseFiles, round);
        compiledArtifacts.push(
          ...(await diffManager.handleLatexdiffOfOutput(round, mapping)),
        );
        await tryOperation(async () => {
          const hadCompileFailures =
            (outputState.rounds.get(round)?.compileFailures.length ?? 0) > 0;
          const check = await runCompileCheck(
            { fileService, outputState, logger, runId },
            round,
          );
          compileRoundResult = check.compileResult;
          compiledArtifacts.push(...check.artifacts);
          const compileFailures = compileFailuresOf(check.compileResult);
          setCompileFailures(outputState, round, compileFailures);
          emitCompileFailures =
            compileFailures.length > 0 || hadCompileFailures;
        }, recoverWarn('Compile check'));
      }
    }
    const summary = await summarizeRound(
      outputState,
      deps,
      outputLocation,
      round,
      { mapping, isRewrite: setting.isRewrite, baseFiles: diffBaseFiles },
    );
    return {
      summary,
      compileResult: compileRoundResult,
      compiledArtifacts,
      emitCompileFailures,
    };
  };

  /** The output pipeline failed: keep what the round reported, drop what it
   *  produced, and summarize what can still be summarized. */
  const fallbackOutput = Effect.fn('reflection.fallbackOutput')(function* (
    round: number,
    outputLocation: AgentFileLocation,
    error: Error,
  ): Effect.fn.Return<OutputExecResult> {
    logger.warn(`Output processing failed: ${error.message}`, { data: error });
    const summary = yield* Effect.tryPromise({
      try: () =>
        run.inScope(() =>
          summarizeRound(outputState, deps, outputLocation, round, {
            isRewrite: setting.isRewrite,
          }),
        ),
      catch: ensureError,
    }).pipe(
      Effect.catch((summaryError) =>
        Effect.sync((): RoundSummary => {
          logger.warn(
            `Output fallback summary failed; output files may be dropped: ${toErrorMessage(summaryError)}`,
            { data: summaryError },
          );
          return { fileInfos: [], filesToOpen: [] };
        }),
      ),
    );
    const roundData = ensureRoundData(outputState, round);
    roundData.rawOutput = null;
    roundData.outputs = [];
    roundData.compileFailures = [];
    return {
      summary,
      compileResult: undefined,
      compiledArtifacts: [],
      emitCompileFailures: false,
    };
  });

  /** Publish the round's facts, open its files, and validate its outputs. */
  const publishOutput = async (
    round: number,
    outputLocation: AgentFileLocation,
    endTurn: boolean,
    result: OutputExecResult,
  ): Promise<void> => {
    const interactions = session.interactions;
    const { summary } = result;
    const compileFailures = compileFailuresOf(result.compileResult);
    // Both facts are latest-only listing rows: each row carries the run's
    // whole round map rather than the round that just finished.
    emitRunFact(logger, 'addOutputFiles', {
      filesByRound: {
        ...getOutputFilesByRound(outputState),
        [round]: summary.fileInfos,
      },
    });
    if (result.emitCompileFailures) {
      emitRunFact(logger, 'updateCompileFailures', {
        filesByRound: {
          ...getCompileFailuresByRound(outputState),
          [round]: compileFailures,
        },
      });
    }
    for (const location of summary.filesToOpen) {
      interactions.emit('requestOpenFile', { location, preserveFocus: true });
    }
    if (
      endTurn &&
      readPlatformSetting<boolean>(WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF)
    ) {
      if (compileFailures.length > 0) {
        for (const failure of compileFailures) {
          interactions.emit('requestOpenFile', {
            location: failure.log,
            preserveFocus: true,
          });
        }
      } else {
        for (const artifact of result.compiledArtifacts) {
          interactions.emit('requestOpenFile', {
            location: artifact,
            preserveFocus: true,
          });
        }
      }
    }
    if (endTurn) {
      await tryOperation(async () => {
        const validation = await checkExpectedOutputs(
          outputState,
          deps,
          outputLocation,
          round,
          summary.stage,
        );
        if (validation.missing.length > 0) {
          interactions.emit('requestShowInstruction', {
            key: 'missingOutputsInfo',
            message: 'Missing output files detected',
          });
        }
      }, recoverWarn('Validate expected outputs'));
    }
    if (result.compileResult) {
      const compileFailureContext = getRejectOnCompileFailure()
        ? formatCompileFailureRoundContext(result.compileResult)
        : undefined;
      if (compileFailureContext) {
        flow = {
          ...flow,
          compileFailureContext,
          unresolvedCompileRejection: true,
        };
      } else {
        delete flow.compileFailureContext;
        delete flow.unresolvedCompileRejection;
      }
    }
  };

  /**
   * The round's output, entered at `output.pending`, which was committed
   * before any file write; re-entry at that phase runs the pipeline again
   * over the same raw output and the run-owned artifacts it already produced.
   */
  const produceOutput = Effect.fn('reflection.produceOutput')(function* (
    state: RunState,
  ): Effect.fn.Return<RunState, Error> {
    const round = flow.currentRound;
    const location = flow.outputLocation;
    if (location === null) {
      return yield* Effect.die(new Error('Output needs the round location.'));
    }
    const endTurn = flow.endTurn;
    const result = yield* Effect.tryPromise({
      try: () => run.inScope(() => processOutput(round, location, endTurn)),
      catch: ensureError,
    }).pipe(Effect.catch((error) => fallbackOutput(round, location, error)));
    yield* Effect.tryPromise({
      try: () =>
        run.inScope(() => publishOutput(round, location, endTurn, result)),
      catch: ensureError,
    });
    return state;
  });

  /** One round inside its trace stage: prompt, response cycles, output. */
  const runRound = Effect.fn('reflection.round')(function* (
    initial: RunState,
  ): Effect.fn.Return<RoundExit, Error> {
    const round = flow.currentRound;
    // The stage closes with the round's own verdict; an exit that never set
    // one is a stop (interrupt) or a defect.
    let roundOutcome: RunOutcome | null = null;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync((): StageHandle =>
            logger.openStage(`r${round}`, {
              parent: run.parentStage,
              kind: 'round',
              index: round,
              total: flow.totalRounds,
            }),
          ),
          (stage, exit) =>
            Effect.sync(() => {
              stage.end(
                roundOutcome ??
                  (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                    ? RUN_OUTCOME.CANCELLED
                    : RUN_OUTCOME.FAILED),
              );
            }),
        );
        let state = initial;
        if (state.phase === 'round.ready') state = yield* prepareRound(state);
        while (
          state.phase === 'model.ready' ||
          state.phase === 'model.submitted' ||
          state.phase === 'response.ready'
        ) {
          const unprocessed =
            state.openAttempt === null &&
            state.lastTurn !== null &&
            state.phase !== 'model.ready';
          if (!unprocessed) {
            const system = yield* Effect.tryPromise({
              try: () =>
                run.inScope(() =>
                  getSystemPromptWithRules(
                    prompt.systemPrompt,
                    run.userVarChannels,
                  ),
                ),
              catch: ensureError,
            });
            const outcome = yield* invoker.invoke(state, {
              system,
              tools: [],
              toolChoice: undefined,
              stopSequences: [OUTPUT_END_TAG],
              round,
              debugName: `r${round}`,
            });
            state = yield* commit(outcome.state);
            if (outcome.kind === 'cancelled') {
              roundOutcome = RUN_OUTCOME.CANCELLED;
              return { state, kind: 'cancelled' } as const;
            }
            if (outcome.kind === 'failed') {
              lastError = outcome.error;
              // A failure the invoker's gate did not already commit (no
              // retry was available) is committed here, so a listing and a
              // resume read the run's error where the gate writes it.
              if (state.lastError === null) {
                state = yield* commit(
                  yield* Effect.uninterruptible(
                    ledger.appendBatch(runId, state, [
                      runtimeSnapshotRow(runId, state, {
                        lastError: outcome.error,
                      }),
                    ]),
                  ),
                );
              }
              roundOutcome = RUN_OUTCOME.FAILED;
              return { state, kind: 'failed' } as const;
            }
            // The retry succeeded: the run is no longer failed, and the next
            // snapshot is what records that.
            lastError = undefined;
            flow = {
              ...flow,
              runStateSnapshot: {
                ...flow.runStateSnapshot,
                totalResponseTimeMs:
                  flow.runStateSnapshot.totalResponseTimeMs +
                  outcome.responseTimeMs,
              },
            };
            // Priced against the binding that served the round: a manual
            // retry may have rebound the model inside the invoker.
            const served = yield* SynchronizedRef.get(run.model);
            yield* Effect.tryPromise({
              try: () =>
                run.inScope(() =>
                  run.usageMonitor.recordUsage(
                    usageSnapshot(state, outcome.usage),
                    served,
                  ),
                ),
              catch: ensureError,
            });
          }
          state = yield* processResponse(state);
        }
        if (state.phase === 'output.pending') {
          state = yield* produceOutput(state);
        }
        roundOutcome = RUN_OUTCOME.COMPLETED;
        return { state, kind: 'completed' } as const;
      }),
    );
  });

  // ------------------------------------------------------------- the loop
  type LoopExit = { readonly state: RunState; readonly outcome: RunOutcome };
  const program = Effect.gen(function* () {
    if (start.resume) yield* ledger.acquire(runId);
    const loaded = yield* ledger.load(runId);
    let state: RunState;
    if (loaded === null) {
      if (start.resume) {
        return yield* Effect.fail(new Error(NOT_RESUMABLE_MESSAGE));
      }
      state = yield* openFresh();
    } else {
      if (!start.resume && loaded.phase !== null) {
        // A fresh launch onto a non-empty aggregate is refused (#11313).
        return yield* Effect.fail(
          new Error(
            `Run ${runId} already has ledger state; resume it instead.`,
          ),
        );
      }
      state = loaded;
      yield* restore(state);
      yield* Ref.set(latest, state);
    }
    // Run-workspace preparation, before the first round: extraction reads
    // the prepared snapshot, and a failure is a transcript warning, never an
    // unhandled rejection.
    yield* Effect.tryPromise({
      try: () =>
        run.inScope(() =>
          fileService.prepareRunWorkspace(baseFiles, {
            linkFiles: collectRunSupportFiles(config),
          }),
        ),
      catch: ensureError,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn(
            `Failed to prepare run workspace; in-place diffs may be empty: ${toErrorMessage(error)}`,
            { data: error, messageType: MESSAGE_TYPES.INTERNAL },
          );
        }),
      ),
    );
    normalizeCompileRejectionPolicy();

    const nextRound = Effect.fn('reflection.nextRound')(function* (
      current: RunState,
    ): Effect.fn.Return<RunState, Error> {
      const ended = coordinates(current);
      flow = {
        ...flow,
        currentRound: flow.currentRound + 1,
        endTurn: false,
        outputLocation: null,
        rawOutputBytes: 0,
      };
      workspace = AgentWorkspaceState.create();
      return yield* commit(
        yield* ledger.appendBatch(runId, current, [
          stepRow(runId, ended, 'round.end'),
          snapshot(current, {
            phase: 'round.ready',
            round: flow.currentRound,
            continuationIndex: 0,
          }),
        ]),
      );
    });
    const finish = Effect.fn('reflection.finish')(function* (
      current: RunState,
      roundEnded: boolean,
    ): Effect.fn.Return<LoopExit, Error> {
      normalizeCompileRejectionPolicy();
      const outcome = resolveOutcome();
      const state = yield* commit(
        yield* ledger.appendBatch(runId, current, [
          ...(roundEnded
            ? [stepRow(runId, coordinates(current), 'round.end')]
            : []),
          snapshot(current, { phase: 'halted' }),
        ]),
      );
      return { state, outcome };
    });

    for (;;) {
      if (state.phase === 'halted') {
        // A finished run launched again continues only if rounds remain
        // under the current configuration. The restored error fact does not
        // decide this: relaunching is the admission of a new attempt, and it
        // clears the error the way a consumed follow-up does in the tool-use
        // loop, so the next snapshot no longer restates a failure the run has
        // moved past.
        if (!(
          flow.continueRounds && flow.currentRound + 1 < flow.totalRounds
        )) {
          return { state, outcome: resolveOutcome() } satisfies LoopExit;
        }
        lastError = undefined;
        flow = {
          ...flow,
          currentRound: flow.currentRound + 1,
          endTurn: false,
          outputLocation: null,
          rawOutputBytes: 0,
        };
        workspace = AgentWorkspaceState.create();
        state = yield* commit(
          yield* ledger.appendBatch(runId, state, [
            snapshot(state, {
              phase: 'round.ready',
              round: flow.currentRound,
              continuationIndex: 0,
            }),
          ]),
        );
      }
      // The configured total may have been lowered since the snapshot; the
      // hard round limit takes precedence over continuing that round.
      if (flow.currentRound >= flow.totalRounds) {
        return yield* finish(state, false);
      }
      const exit = yield* runRound(state);
      state = exit.state;
      if (exit.kind === 'cancelled') {
        return { state, outcome: RUN_OUTCOME.CANCELLED } satisfies LoopExit;
      }
      if (exit.kind === 'failed') {
        return { state, outcome: RUN_OUTCOME.FAILED } satisfies LoopExit;
      }
      if (!shouldContinueNextRound()) return yield* finish(state, true);
      state = yield* nextRound(state);
    }
  });

  const result = (
    outcome: RunOutcome,
    at: RunState | null,
  ): ReflectionResult => ({
    outcome,
    roundOutputs: roundsToPersisted(outputState),
    usage: at?.usage ?? EMPTY_RUN_USAGE_TOTALS,
    ...(lastError !== undefined && outcome === RUN_OUTCOME.FAILED
      ? { error: lastError }
      : {}),
  });

  /**
   * The exit protocol: the halt row happens whether the loop returned,
   * failed, or was interrupted by a host stop. It hangs off `onExit` rather
   * than an `Effect.exit` followed by a masked block — an external interrupt
   * unwinds straight past `Effect.exit`, which left the `halted` step
   * unwritten.
   */
  const finalize = (exit: Exit.Exit<LoopExit, Error>) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const state = yield* Ref.get(latest);
        const halt = (outcome: RunOutcome) =>
          state === null || state.phase === null
            ? Effect.void
            : ledger
                .appendBatch(runId, state, [
                  haltedStepRow(runId, coordinates(state), outcome),
                ])
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      logger.warn('Failed to record the run halt', {
                        data: error,
                      }),
                    ),
                  ),
                );
        if (Exit.isSuccess(exit)) return yield* halt(exit.value.outcome);
        if (Cause.hasInterrupts(exit.cause)) {
          return yield* halt(RUN_OUTCOME.CANCELLED);
        }
        yield* halt(RUN_OUTCOME.FAILED);
      }),
    );

  /** The caller's error for a run that ended in a failure cause. */
  const failure = (error: unknown): Error =>
    error instanceof RunLedgerRefused
      ? new Error(
          `The run ledger refused a write (${error.reason}): ${error.detail}`,
          { cause: error },
        )
      : ensureError(error);

  return yield* program.pipe(
    Effect.onExit(finalize),
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const stopped = failure(Cause.squash(cause));
      logger.warn(`Reflection run ${runId} stopped: ${stopped.message}`);
      return Effect.fail(stopped);
    }),
  );
});

function collectRunSupportFiles(agentConfig: {
  readonly contextFiles: readonly string[];
  readonly mediaFiles: readonly string[];
  readonly inputFiles: readonly string[];
}): FileLocation[] {
  const extras = new Map<string, FileLocation>();
  for (const value of [
    ...agentConfig.contextFiles,
    ...agentConfig.mediaFiles,
    ...agentConfig.inputFiles,
  ]) {
    if (!value) continue;
    const location = pathToLocation(value);
    extras.set(fileLocationDisplayPath(location), location);
  }
  return [...extras.values()];
}
