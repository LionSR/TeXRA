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
import { Cause, Effect, Exit, FileSystem, SynchronizedRef } from 'effect';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { userRequestTemplateCount } from '@agent/index/agentYamlScanner';
import { compileFailuresOf, runCompileCheck } from '@agent/output/compileCheck';
import {
  appendCompileFailureRoundContext,
  formatCompileFailureRoundContext,
} from '@agent/output/compileFailureRoundContext';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import { traceFileLineage } from '@agent/output/lineageMapping';
import { extractFilesFromXml } from '@agent/output/outputFileExtraction';
import { recoverOutputFailure } from '@agent/output/outputOperations';
import {
  createOutputState,
  ensureRoundData,
  getOutputFilesByRound,
  roundsFromPersisted,
  roundsToPersisted,
  setCompileFailures,
  type OutputDependencies,
} from '@agent/output/outputState';
import { checkExpectedOutputs } from '@agent/output/outputValidation';
import { summarizeRound, type RoundSummary } from '@agent/output/roundSummary';
import { resolveBaseFilesForDiff } from '@agent/output/snapshotResolution';
import type { RoundFileMapping } from '@agent/output/types';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import {
  getSystemPromptWithRules,
  PromptBuilder,
} from '@agent/prompt/PromptBuilder';
import { logUserMessage } from '@agent/trace';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import { getTeXCountStats } from '@latex/texcount';
import type { WorkspaceFs } from '@platform/rootedFs';
import type { LanguageModel } from '@platform/languageModel';
import {
  WORKFLOW_OUTPUT_BASENAME,
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
  workflowOutputRoundDir,
} from '@shared/constants/workflowOutput';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import {
  AgentCategory,
  fileLocationDisplayPath,
  MESSAGE_TYPES,
  isTerminalCompileRejection,
  OUTPUT_END_TAG,
  RUN_OUTCOME,
  SCRATCHPAD_TAG,
  type AgentFileLocation,
  type CompileResult,
  type FileLocation,
  type RetryErrorInfo,
  type RoundOutput,
  type RunOutcome,
  type RunStorageFileLocation,
  type RunUsageTotals,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { type RunState } from '@shared/session/runStateFold';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { absentReason } from '@utils/files/fsEntryExists';
import { extractScratchpad } from '@utils/text/xmlExtraction';
import { AgentRun } from '../run/AgentRun';
import { compactIfNeeded } from '../run/compaction';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { turnText } from '../run/turnText';
import { ModelInvoker } from '../ModelInvoker';
import { Runs } from '../runRegistry';
import {
  appendRow,
  familyState,
  rowAggregate,
  snapshotRow,
  stepRow,
  type ReflectionFlowState,
  type SnapshotPatch,
} from './rows';
import {
  loadRun,
  makeRunCell,
  recordServedUsage,
  settleRun,
  stagedBy,
  stoppedBy,
  type RunCell,
} from './runProgram';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';
import type { HttpClient } from 'effect/unstable/http';

/** The services a round prepares, compiles and diffs on. */
type RoundServices = FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner;

// Reflection owns conversation limits and document completion, not the provider.
/** Length for preview slices of tool output and responses. */
const K_SLICE = 200;
const CONTINUE_LIMIT = 10;
const INPUT_TOKEN_LIMIT = 1500000;
const OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

interface ReflectionStart {
  /** The caller launched this as a resume; the ledger decides what it is. */
  readonly resume: boolean;
}

interface ReflectionResult {
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
}

type RoundExit = {
  readonly state: RunState;
  readonly kind: RunOutcome;
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
  | AgentRun
  | RunLedger
  | ModelInvoker
  | FileSystem.FileSystem
  | WorkspaceFs
  | LanguageModel
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Runs
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
  // The run's session roots, as data: the output pipeline's workspace,
  // storage and setting reads take them from here, so the answer cannot
  // depend on which fiber turn this program resumes in.
  const { roots } = session;
  const getRejectOnCompileFailure = () =>
    readSettingFrom<boolean>(
      roots,
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
    roots.config,
  );
  const diffManager = new LatexDiffManager(
    setting.isRewrite,
    () => getOutputFilesByRound(outputState),
    logger,
    runId,
    fileService,
    roots,
  );
  const promptBuilder = new PromptBuilder(
    prompt,
    run.userVarChannels,
    roots.workspace,
    logger,
  );
  const latexMediaManager = new LatexMediaManager(logger, roots, fileService);
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
    roots,
  };
  /** An output step whose failure costs that step, not the round: reported at
   *  `warn` on the transcript, then the pipeline carries on. */
  const recoverWarn = (label: string) =>
    recoverOutputFailure({
      logger,
      level: 'warn' as const,
      label,
      messageType: MESSAGE_TYPES.DEFAULT,
      recover: () => Effect.void,
    });

  // ---------------------------------------------------------------- state
  let workspace = AgentWorkspaceState.create();
  // The family state no row carries: the round budget and the compile
  // rejection facts. The round is the folded `state.round`.
  let flow: ReflectionFlowState = {
    totalRounds,
    workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
  };
  /** The family state every snapshot of this run carries. */
  const flowState = (): ReflectionFlowState => ({
    ...flow,
    workspaceSnapshot: workspace.toSnapshot({ excludeAssemblyStrings: true }),
  });
  const snapshot = (state: RunState, patch: Omit<SnapshotPatch, 'state'>) =>
    snapshotRow(runId, state, {
      ...patch,
      state: { family: 'reflection', state: flowState() },
    });
  /** Disabling rejection is an explicit acceptance decision. */
  const normalizeCompileRejectionPolicy = Effect.fn(function* () {
    if (
      (yield* getRejectOnCompileFailure()) ||
      (!flow.unresolvedCompileRejection && !flow.compileFailureContext)
    ) {
      return;
    }
    delete flow.unresolvedCompileRejection;
    delete flow.compileFailureContext;
  });
  const resolveOutcome = (state: RunState): RunOutcome =>
    deriveRunOutcome({
      failed:
        state.lastError !== null ||
        isTerminalCompileRejection(flow, state.round),
      cancelled: false,
    });
  /** The round loop's single continue/finalize decision. */
  const shouldContinueNextRound = (state: RunState): boolean =>
    state.lastError === null && state.round + 1 < totalRounds;

  /**
   * A committed response's text as the round writes it, and whether it ended
   * the turn: a stop with text. The turn sends no stop sequence — the Google,
   * OpenAI Chat and OpenAI Responses protocols refuse one — so the closing
   * tag stays in the text and the continuation check reads it there.
   */
  const responseOf = (turn: NonNullable<RunState['lastTurn']>) =>
    Effect.map(
      session.responseTextProcessing.postProcessResponse(
        turnText(turn),
        session.roots.config,
      ),
      (text) => {
        const finish = finishReasonOf(turn);
        const endTurn = text !== '' && finish === 'stop';
        return { finish, text, endTurn };
      },
    );

  /** The files a round works on: inputs first, then the previous outputs. */
  const filesForRound = (round: number): FileLocation[] => {
    if (round === 0) {
      return config.inputFiles.map((f) => fileService.createLocation(f));
    }
    const previous = outputState.rounds.get(round - 1);
    if (previous?.outputs.length) {
      return previous.outputs.map((o) => o.location);
    }
    return config.outputFiles.map((f) => fileService.createLocation(f));
  };

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('reflection.open')(function* (
    opening: RunState,
  ): Effect.fn.Return<RunState, Error> {
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
      snapshotRow(runId, opening, {
        phase: 'round.ready',
        round: 0,
        runtime: {
          modelId: bound.modelId,
          modelCompatibilityKey: bound.compatibilityKey,
        },
        state: { family: 'reflection', state: flowState() },
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return opened;
  });

  /** Restore the family state a resumed run continues from. */
  const restore = Effect.fn('reflection.restore')(function* (
    state: RunState,
  ): Effect.fn.Return<void, Error, FileSystem.FileSystem> {
    const persisted = familyState(state, 'reflection');
    if (persisted === null) {
      return yield* Effect.die(
        new Error(`Run ${runId} is not a reflection run; resume it as one.`),
      );
    }
    // The configured total wins over the persisted one, so a YAML change
    // (rounds: 2 -> 1) takes effect on resume; a resumed run retries the
    // invocation its failure interrupted rather than failing again at once.
    flow = { ...persisted, totalRounds };
    workspace = AgentWorkspaceState.fromSnapshot(persisted.workspaceSnapshot);
    outputState.rounds = roundsFromPersisted(state.roundOutputs);
    // Mid-round, the cycle files hold the text every earlier response cycle
    // produced; the next connector and continuation prompt read their tail.
    // `continuationIndex` is folded state, so no directory enumeration is
    // needed to find them.
    if (state.phase === 'model.ready' || state.phase === 'model.submitted') {
      const content = yield* readRawOutput(
        state.round,
        state.continuationIndex,
      );
      workspace.assembly.accumulatedOutput = content;
      workspace.assembly.lastResponse = content;
    }
    logger.debug(
      `Resuming reflection run from round ${state.round}/${totalRounds}`,
    );
  });

  // ----------------------------------------------------------- the round
  /** The round prompt, its media and TeX count, committed with `round.begin`. */
  const prepareRound = Effect.fn('reflection.prepareRound')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState, Error, RoundServices> {
    const round = initial.round;
    const bound = yield* SynchronizedRef.get(run.model);
    workspace = AgentWorkspaceState.create();
    const files = filesForRound(round);
    const content: InputPart[] = [];

    if (config.toolConfig.attachTeXCount && files.length > 0) {
      const counted = yield* Effect.exit(
        getTeXCountStats(
          roots.workspace,
          roots,
          files.map((f) => f.absolutePath),
        ),
      );
      if (Exit.isFailure(counted)) {
        if (Cause.hasInterrupts(counted.cause)) return yield* Effect.interrupt;
        logger.debug('TeXCount skipped', { data: Cause.squash(counted.cause) });
      } else if (counted.value) {
        content.push({ kind: 'text', text: counted.value });
      }
    }

    let requestText: string;
    if (round === 0) {
      const initialPrompts = yield* promptBuilder.buildInitialPrompts();
      const prefix = initialPrompts.userPrefix.trim();
      if (prefix) content.push({ kind: 'text', text: prefix });
      requestText = initialPrompts.userRequest.trim();
    } else {
      const request = yield* promptBuilder.buildUserRequest(round);
      requestText = appendCompileFailureRoundContext(
        request,
        flow.compileFailureContext,
      ).trim();
      delete flow.compileFailureContext;
    }

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
          : fileService
              .ensureMirroredInRoundDir(round)
              .pipe(
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
            run.session.roots.config,
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
    const prepared = yield* cell.append([
      appendRow(runId, [{ role: 'user', content }]),
      snapshot(initial, { phase: 'model.ready', round, continuationIndex: 0 }),
      stepRow(runId, initial, 'round.begin'),
    ]);
    return prepared;
  });

  /**
   * The raw output of one response cycle, keyed by the folded
   * `continuationIndex`: a re-entry at the same cycle rewrites the same path
   * with the same bytes, so the write is idempotent by coordinate and needs
   * no byte-offset bookkeeping; raw/ is outside extracted round files.
   */
  const cycleLocationFor = (
    round: number,
    continuationIndex: number,
  ): AgentFileLocation =>
    fileService.createLocation(
      `raw/${workflowOutputRoundDir(round)}/${WORKFLOW_OUTPUT_BASENAME}.c${continuationIndex}.${WORKFLOW_RAW_OUTPUT_EXT}`,
    ) as AgentFileLocation;

  /**
   * The round's accumulated raw output: its cycle files read back in index
   * order, cycles `0 .. count - 1`. A cycle that produced no text left no
   * file; a file the resume finds gone contributes no text, and the round
   * rebuilds it from the rows that follow. Any other read failure —
   * permissions, a directory, I/O — still fails rather than quietly
   * continuing without the earlier responses.
   */
  const readRawOutput = (
    round: number,
    count: number,
  ): Effect.Effect<string, Error, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let raw = '';
      for (let index = 0; index < count; index++) {
        raw += yield* fs
          .readFileString(cycleLocationFor(round, index).absolutePath)
          .pipe(Effect.catchIf(absentReason, () => Effect.succeed('')));
      }
      return raw;
    });

  /**
   * Process the committed response the state holds: write its text to the
   * raw output, then commit the next phase, a continuation with its prompt
   * or `output.ready`, together with `response.processed`.
   */
  const processResponse = Effect.fn('reflection.processResponse')(function* (
    initial: RunState,
    cell: RunCell,
  ): Effect.fn.Return<
    RunState,
    Error,
    FileSystem.FileSystem | HttpClient.HttpClient
  > {
    const turn = initial.lastTurn;
    if (turn === null) {
      return yield* Effect.die(
        new Error('A response is processed only after its row and its round.'),
      );
    }
    const { finish, text, endTurn } = yield* responseOf(turn);
    logger.debug(`Stop reason: ${finish}`);
    const scratchpad = extractScratchpad(text, SCRATCHPAD_TAG);
    if (scratchpad) {
      logger.info(scratchpad, { messageType: MESSAGE_TYPES.SCRATCHPAD });
    }

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
     * overflow in the round (the fold records the round of its
     * `context-window` compaction), or a compaction that shortened nothing,
     * stops, because the same history would overflow again.
     */
    const admitOverflowRetry = Effect.fn('reflection.overflowRetry')(
      function* (): Effect.fn.Return<boolean, Error> {
        if (base.overflowRecoveredAtRound === base.round) {
          logger.warn(
            'Model context window still exceeded after forced compaction; stopping to avoid a futile retry.',
          );
          return false;
        }
        const bound = yield* SynchronizedRef.get(run.model);
        // The retry pays for a summary first: the compaction row is committed
        // before the continuation prompt, so the retried request is issued
        // against the compacted history the fold returns.
        const compacted = yield* cell.adopt(
          yield* compactIfNeeded(base, {
            runId,
            ledger,
            logger,
            bound,
            stores: session.roots,
            system: undefined,
            tools: [],
            force: 'overflow',
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
      const fs = yield* FileSystem.FileSystem;
      const cyclePath = cycleLocationFor(
        initial.round,
        initial.continuationIndex,
      ).absolutePath;
      yield* fs.makeDirectory(dirname(cyclePath), { recursive: true });
      yield* fs.writeFileString(
        cyclePath,
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
      const progressed = { ...base, continuationIndex: next };
      return yield* cell.append([
        appendRow(runId, [
          {
            role: 'user',
            content: [{ kind: 'text', text: continuationPrompt }],
          },
        ]),
        snapshot(base, {
          phase: 'model.ready',
          continuationIndex: next,
          // A response arrived: the run is no longer failed, and this
          // snapshot is what records that.
          runtime: { lastError: null },
        }),
        stepRow(runId, progressed, 'response.processed'),
      ]);
    }
    // `output.pending` is committed before any output file is touched, so
    // a re-entry at this phase knows the pipeline may have started.
    return yield* cell.append([
      snapshot(initial, {
        phase: 'output.pending',
        runtime: { lastError: null },
      }),
      stepRow(runId, initial, 'response.processed'),
      stepRow(runId, initial, 'output.ready'),
    ]);
  });

  /** The output pipeline over the round's raw output: extraction, lineage,
   *  latexdiff, the compile check, and the round summary. */
  const processOutput = Effect.fn('reflection.processOutput')(function* (
    round: number,
    outputLocation: AgentFileLocation,
    endTurn: boolean,
  ): Effect.fn.Return<OutputExecResult, Error, RoundServices> {
    const diffBaseFiles = yield* resolveBaseFilesForDiff(
      baseFiles,
      runId,
      roots,
    );
    let mapping: RoundFileMapping | undefined;
    let compileRoundResult: CompileResult | undefined;
    const compiledArtifacts: RunStorageFileLocation[] = [];
    if (endTurn) {
      logger.debug(`Processing output for round ${round}`);
      yield* xmlManager
        .ensureCorrectXmlStructure(outputLocation)
        .pipe(recoverWarn('XML structure'));
      yield* extractFilesFromXml(
        outputState,
        deps,
        xmlManager,
        outputLocation,
        round,
      ).pipe(recoverWarn('Output processing'));
      if ((outputState.rounds.get(round)?.outputs.length ?? 0) > 0) {
        mapping = traceFileLineage(outputState, diffBaseFiles, round);
        compiledArtifacts.push(
          ...(yield* diffManager.handleLatexdiffOfOutput(round, mapping)),
        );
        yield* Effect.gen(function* () {
          const check = yield* runCompileCheck(
            {
              roots,
              fileService,
              outputState,
              logger,
              runId,
            },
            round,
          );
          compileRoundResult = check.compileResult;
          compiledArtifacts.push(...check.artifacts);
          const compileFailures = compileFailuresOf(check.compileResult);
          setCompileFailures(outputState, round, compileFailures);
        }).pipe(recoverWarn('Compile check'));
      }
    }
    const summary = yield* summarizeRound(
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
    };
  });

  /** The output pipeline failed: keep what the round reported, drop what it
   *  produced, and summarize what can still be summarized. */
  const fallbackOutput = Effect.fn('reflection.fallbackOutput')(function* (
    round: number,
    outputLocation: AgentFileLocation,
    error: Error,
  ): Effect.fn.Return<OutputExecResult, never, FileSystem.FileSystem> {
    logger.warn(`Output processing failed: ${error.message}`, { data: error });
    const summary = yield* summarizeRound(
      outputState,
      deps,
      outputLocation,
      round,
      { isRewrite: setting.isRewrite },
    ).pipe(
      Effect.catch((summaryError) =>
        Effect.sync((): RoundSummary => {
          logger.warn(
            `Output fallback summary failed; output files may be dropped: ${toErrorMessage(summaryError)}`,
            { data: summaryError },
          );
          return { filesToOpen: [] };
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
    };
  });

  /** Open produced files and apply the round's compile policy. */
  const presentOutput = Effect.fn('reflection.presentOutput')(function* (
    endTurn: boolean,
    result: OutputExecResult,
  ) {
    const interactions = session.interactions;
    const { summary } = result;
    const compileFailures = compileFailuresOf(result.compileResult);
    for (const location of summary.filesToOpen) {
      yield* interactions.emit('requestOpenFile', {
        location,
        preserveFocus: true,
      });
    }
    if (
      endTurn &&
      (yield* readSettingFrom<boolean>(
        roots,
        WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
      ))
    ) {
      // A failed compile opens its log; a clean round opens what it produced.
      const locationsToOpen =
        compileFailures.length > 0
          ? compileFailures.map((failure) => failure.log)
          : result.compiledArtifacts;
      for (const location of locationsToOpen) {
        yield* interactions.emit('requestOpenFile', {
          location,
          preserveFocus: true,
        });
      }
    }
    if (result.compileResult) {
      const compileFailureContext = (yield* getRejectOnCompileFailure())
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
  });

  /**
   * The round's output, entered at `output.pending`, which was committed
   * before any file write; re-entry at that phase runs the pipeline again
   * over the same raw output and the run-owned artifacts it already produced.
   */
  const produceOutput = Effect.fn('reflection.produceOutput')(function* (
    state: RunState,
    cell: RunCell,
  ): Effect.fn.Return<RunState, Error, RoundServices> {
    const round = state.round;
    const location = outputLocationFor(round);
    if (state.lastTurn === null) {
      return yield* Effect.die(new Error('Output needs the round response.'));
    }
    // Whether the round's last response ended the turn, from the folded
    // turn: the same rule `processResponse` applied before committing
    // `output.pending`.
    const { endTurn } = yield* responseOf(state.lastTurn);
    // The canonical raw output the pipeline reads is the round's cycle files
    // concatenated in index order; re-entry rewrites it whole from the same
    // coordinates.
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* readRawOutput(round, state.continuationIndex + 1);
    yield* fs.makeDirectory(dirname(location.absolutePath), {
      recursive: true,
    });
    yield* fs.writeFileString(location.absolutePath, raw);
    const result = yield* processOutput(round, location, endTurn).pipe(
      // The pipeline's own steps recover what they can; anything that still
      // reaches here — a failed step or a defect in one — costs the round its
      // outputs, not the run. Interruption is not an output failure and stays
      // a cancelled run.
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : fallbackOutput(round, location, ensureError(Cause.squash(cause))),
      ),
    );
    if (endTurn) {
      yield* Effect.gen(function* () {
        const validation = yield* checkExpectedOutputs(
          outputState,
          deps,
          location,
          round,
        );
        if (validation.missing.length > 0) {
          yield* session.interactions.emit('requestShowInstruction', {
            key: 'missingOutputsInfo',
            message: 'Missing output files detected',
          });
        }
      }).pipe(recoverWarn('Validate expected outputs'));
    }
    // The row owns completed outputs. Commit it before fallible presentation
    // and policy reads; output.pending stays replayable until round end.
    const produced = yield* cell.append([
      {
        type: 'output.produced',
        aggregateId: rowAggregate(runId),
        rounds: roundsToPersisted(outputState),
      },
    ]);
    yield* presentOutput(endTurn, result);
    return produced;
  });

  /** One round inside its trace stage: prompt, response cycles, output. */
  const runRound = Effect.fn('reflection.round')(function* (
    cell: RunCell,
  ): Effect.fn.Return<
    RoundExit,
    Error,
    RoundServices | LanguageModel | HttpClient.HttpClient
  > {
    const round = (yield* cell.current).round;
    const body = Effect.gen(function* () {
      let state = yield* cell.current;
      if (state.phase === 'round.ready')
        state = yield* prepareRound(state, cell);
      while (
        state.phase === 'model.ready' ||
        state.phase === 'model.submitted'
      ) {
        const unprocessed =
          state.openAttempt === null &&
          state.lastTurn !== null &&
          state.phase !== 'model.ready';
        if (!unprocessed) {
          const system = yield* getSystemPromptWithRules(
            prompt.systemPrompt,
            run.userVarChannels,
            roots.workspace,
          );
          const outcome = yield* invoker.invoke(cell, {
            system,
            tools: [],
            toolChoice: undefined,
            round,
            debugName: `r${round}`,
          });
          state = outcome.state;
          if (outcome.kind === 'cancelled') {
            return { state, kind: 'cancelled' } as const;
          }
          if (outcome.kind === 'failed') {
            return { state, kind: 'failed' } as const;
          }
          yield* recordServedUsage(run, state, outcome.usage);
        }
        state = yield* processResponse(state, cell);
      }
      if (state.phase === 'output.pending') {
        state = yield* produceOutput(state, cell);
      }
      return { state, kind: 'completed' } as const;
    });
    return yield* stagedBy(
      () =>
        logger.openStage(`r${round}`, {
          parent: run.parentStage,
          kind: 'round',
          index: round,
          total: totalRounds,
        }),
      (exit: RoundExit) => exit.kind,
    )(body);
  });

  // ------------------------------------------------------------- the loop
  type LoopExit = { readonly state: RunState; readonly outcome: RunOutcome };
  const enter = Effect.gen(function* () {
    const entry = yield* loadRun(runId, 'reflection', start.resume);
    const opened =
      entry._tag === 'fresh'
        ? yield* openFresh(entry.opening)
        : yield* Effect.as(restore(entry.loaded), entry.loaded);
    return yield* makeRunCell(runId, opened);
  });

  const loopBody = (cell: RunCell) =>
    Effect.gen(function* () {
      // Run-workspace preparation, before the first round: extraction reads
      // the prepared snapshot, and a failure is a transcript warning, never
      // an unhandled rejection.
      yield* fileService
        .prepareRunWorkspace(baseFiles, {
          linkFiles: collectRunSupportFiles(roots.workspace, config),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn(
                `Failed to prepare run workspace; in-place diffs may be empty: ${toErrorMessage(error)}`,
                { data: error, messageType: MESSAGE_TYPES.INTERNAL },
              );
            }),
          ),
        );
      yield* normalizeCompileRejectionPolicy();

      /**
       * Advance onto the next round: reset the per-round flow facts and
       * workspace, then commit the `round.ready` snapshot.
       *
       * `closePrevious` says whether a round is actually being closed. Ending
       * one emits `round.end` against the folded state captured *before* the
       * advance; relaunching a halted run enters a round without a
       * predecessor to close, and that is the only difference between the two
       * entries. The snapshot clears the error fact: relaunching is the
       * admission of a new attempt, so nothing restates a failure the run has
       * moved past.
       */
      const enterRound = Effect.fn('reflection.enterRound')(function* (
        current: RunState,
        closePrevious: boolean,
      ): Effect.fn.Return<RunState, Error> {
        workspace = AgentWorkspaceState.create();
        return yield* cell.append([
          ...(closePrevious ? [stepRow(runId, current, 'round.end')] : []),
          snapshot(current, {
            phase: 'round.ready',
            round: current.round + 1,
            continuationIndex: 0,
            runtime: { lastError: null },
          }),
        ]);
      });
      const finish = Effect.fn('reflection.finish')(function* (
        current: RunState,
        roundEnded: boolean,
      ): Effect.fn.Return<LoopExit, Error, ChildProcessSpawner> {
        yield* normalizeCompileRejectionPolicy();
        const outcome = resolveOutcome(current);
        const state = yield* cell.append([
          ...(roundEnded ? [stepRow(runId, current, 'round.end')] : []),
          snapshot(current, { phase: 'halted' }),
        ]);
        return { state, outcome };
      });

      for (;;) {
        let state = yield* cell.current;
        if (state.phase === 'halted') {
          // A finished run launched again continues only if rounds remain
          // under the current configuration. The restored error fact does not
          // decide this: relaunching is the admission of a new attempt.
          if (state.round + 1 >= totalRounds) {
            return {
              state,
              outcome: resolveOutcome(state),
            } satisfies LoopExit;
          }
          state = yield* enterRound(state, false);
        }
        // The configured total may have been lowered since the snapshot; the
        // hard round limit takes precedence over continuing that round.
        if (state.round >= totalRounds) {
          return yield* finish(state, false);
        }
        const exit = yield* runRound(cell);
        state = exit.state;
        if (exit.kind === 'cancelled') {
          return { state, outcome: RUN_OUTCOME.CANCELLED } satisfies LoopExit;
        }
        if (exit.kind === 'failed') {
          return { state, outcome: RUN_OUTCOME.FAILED } satisfies LoopExit;
        }
        if (!shouldContinueNextRound(state)) return yield* finish(state, true);
        state = yield* enterRound(state, true);
      }
    });

  const result = (outcome: RunOutcome, at: RunState): ReflectionResult => ({
    outcome,
    roundOutputs: roundsToPersisted(outputState),
    usage: at.usage,
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { error: at.lastError }
      : {}),
  });

  // Every ledger append the loop makes is uninterruptible inside
  // `cell.append`, so the halt the release writes never folds onto a state
  // behind the rows. Reflection holds no input lease.
  return yield* Effect.acquireUseRelease(enter, loopBody, (cell, exit) =>
    settleRun(cell, logger, null)(exit),
  ).pipe(
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause(stoppedBy(logger, `Reflection run ${runId}`)),
  );
});

function collectRunSupportFiles(
  workspaceRoot: string | undefined,
  agentConfig: {
    readonly contextFiles: readonly string[];
    readonly mediaFiles: readonly string[];
    readonly inputFiles: readonly string[];
  },
): FileLocation[] {
  const extras = new Map<string, FileLocation>();
  for (const value of [
    ...agentConfig.contextFiles,
    ...agentConfig.mediaFiles,
    ...agentConfig.inputFiles,
  ]) {
    if (!value) continue;
    const location = pathToLocationIn(workspaceRoot, value);
    extras.set(fileLocationDisplayPath(location), location);
  }
  return [...extras.values()];
}
