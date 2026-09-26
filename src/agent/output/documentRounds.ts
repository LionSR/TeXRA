/**
 * The documents plugin: what a workflow agent does around each model turn.
 * Before a round it builds the round's user content (TeXCount, the
 * `userRequest` template, input media on round 0 and the previous round's
 * figures after it, the compile-failure context of a rejected round); after a
 * round it runs the output pipeline over the turn's text (XML extraction,
 * lineage, latexdiff, the compile check, the round summary), commits
 * `output.produced` through the run cell and presents the result.
 *
 * It owns the round's output state and the compile-rejection facts. It does
 * not own the loop: the caller decides when a round opens, issues the turn,
 * and appends every row except `output.produced`, which it hands the cell for.
 */
import { dirname } from 'node:path';
import { Cause, Effect, Exit, FileSystem, SynchronizedRef } from 'effect';

import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
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
import type { RoundFileMapping } from '@agent/output/types';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { PromptBuilder } from '@agent/prompt/PromptBuilder';
import { AgentRun } from '@agent/runtime/run/AgentRun';
import { mediaInputParts, type InputPart } from '@agent/runtime/run/mediaInput';
import {
  familyState,
  rowAggregate,
  type ReflectionFlowState,
} from '@agent/runtime/loop/rows';
import type { RunCell } from '@agent/runtime/loop/runProgram';
import { logUserMessage } from '@agent/trace';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import { getTeXCountStats } from '@latex/texcount';
import type { WorkspaceFs } from '@platform/rootedFs';
import {
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';
import {
  fileLocationDisplayPath,
  isTerminalCompileRejection,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  type AgentFileLocation,
  type CompileResult,
  type FileLocation,
  type RoundOutput,
  type RunStorageFileLocation,
} from '@shared/schemas';
import type { RunState } from '@shared/session/runStateFold';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** The services a round prepares, compiles and diffs on. */
export type RoundServices =
  FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner;

/** Why a turn ended; the editor arm, which reports none, reads as `stop`. */
export type TurnFinish = Extract<
  NonNullable<RunState['lastTurn']>,
  { kind: 'http' }
>['finishReason'];

interface OutputExecResult {
  summary: RoundSummary;
  compileResult?: CompileResult;
  compiledArtifacts: RunStorageFileLocation[];
}

/**
 * Build the plugin for one run of a workflow agent, from the run in context.
 * The caller calls `opening` on a fresh run or `restore` on a resumed one,
 * then `enter` on every entry, then `nextRound` / `afterTurn` per round.
 */
export const makeDocumentRounds = Effect.fn('documentRounds.make')(function* (
  setting: AgentWorkflowSetting,
) {
  const run = yield* AgentRun;
  const { runId, session, logger, config, prompt, fileService } = run;
  // The run's session roots, as data: the pipeline's workspace, storage and
  // setting reads take them from here, so the answer cannot depend on which
  // fiber turn the caller resumes in.
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
  const deps: OutputDependencies = {
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

  let workspace = AgentWorkspaceState.create();
  /** Where each base file's pre-run content lives, as `prepareRunWorkspace`
   *  decided it: every round diffs against these, never the live file an
   *  in-place round overwrote. */
  let diffBaseFiles = baseFiles;
  // The round budget and the compile-rejection facts no row carries.
  let flow: ReflectionFlowState = {
    totalRounds,
    workspaceSnapshot: AgentWorkspaceState.emptySnapshot(),
  };
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

  /** The round's user content: TeX count, prompt, media and request. */
  const nextRound = Effect.fn('documentRounds.nextRound')(function* (
    round: number,
  ): Effect.fn.Return<InputPart[], Error, RoundServices> {
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
            roots.config,
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
    return content;
  });

  /** The output pipeline over the round's raw output: extraction, lineage,
   *  latexdiff, the compile check, and the round summary. */
  const processOutput = Effect.fn('documentRounds.processOutput')(function* (
    round: number,
    outputLocation: AgentFileLocation,
    endTurn: boolean,
  ): Effect.fn.Return<OutputExecResult, Error, RoundServices> {
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
            { roots, fileService, outputState, logger, runId },
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
    return { summary, compileResult: compileRoundResult, compiledArtifacts };
  });

  /** The output pipeline failed: keep what the round reported, drop what it
   *  produced, and summarize what can still be summarized. */
  const fallbackOutput = Effect.fn('documentRounds.fallbackOutput')(function* (
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
    return { summary, compileResult: undefined, compiledArtifacts: [] };
  });

  /** Open produced files and apply the round's compile policy. */
  const presentOutput = Effect.fn('documentRounds.presentOutput')(function* (
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
   * The round's output from its turn's text. The raw output file is
   * rewritten whole from the text, so running it again for the same round
   * reruns the pipeline over the same raw output and the run-owned artifacts
   * it already produced. The text is extracted when it stopped, was cut off
   * by the output limit (as far as it got), or closes the documents: the turn
   * sends no stop sequence, so the closing tag stays in the text.
   */
  const afterTurn = Effect.fn('documentRounds.afterTurn')(function* (
    round: number,
    response: { readonly text: string; readonly finish: TurnFinish },
    cell: RunCell,
  ): Effect.fn.Return<RunState, Error, RoundServices> {
    const { text, finish } = response;
    const endTurn =
      text !== '' &&
      (finish === 'stop' ||
        finish === 'length' ||
        text.includes(OUTPUT_END_TAG));
    const location = fileService.createLocation(
      workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round }),
    ) as AgentFileLocation;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(location.absolutePath), {
      recursive: true,
    });
    yield* fs.writeFileString(location.absolutePath, text);
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
    // and policy reads.
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

  return {
    totalRounds,
    /** A fresh run's opening. A workflow YAML may still declare `tools:`;
     *  a documents round advertises none, so the narrowing is stated rather
     *  than silent. */
    opening: Effect.sync(() => {
      if (setting.tools.length === 0) return;
      const declared = setting.tools.map((tool) => tool.name).join(', ');
      logger.warn(
        `The workflow family advertises no tools under this release, so the tools resolved for this run are not offered to the model: ${declared}. Run the agent in the tool-use family if it needs them.`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
    }),
    /** Restore the outputs, and the facts a reflection snapshot carries, of a
     *  resumed run. The configured total wins over the persisted one, so a
     *  YAML change (rounds: 2 -> 1) takes effect on resume. */
    restore: (state: RunState): void => {
      const persisted = familyState(state, 'reflection');
      if (persisted !== null) {
        flow = { ...persisted, totalRounds };
        workspace = AgentWorkspaceState.fromSnapshot(
          persisted.workspaceSnapshot,
        );
      }
      outputState.rounds = roundsFromPersisted(state.roundOutputs);
    },
    /** Every entry, fresh or resumed, before a round: run-workspace
     *  preparation (extraction reads the prepared snapshot; a failure is a
     *  transcript warning) and the current rejection policy. */
    enter: Effect.gen(function* () {
      diffBaseFiles = yield* fileService
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
              return baseFiles;
            }),
          ),
        );
      yield* normalizeCompileRejectionPolicy();
    }),
    nextRound,
    afterTurn,
    /** Whether ending at `round` leaves a compile rejection unresolved under
     *  the current policy. */
    rejected: (round: number) =>
      Effect.map(normalizeCompileRejectionPolicy(), () =>
        isTerminalCompileRejection(flow, round),
      ),
    /** The reflection snapshot's family state: the flow facts and the round's
     *  media workspace. */
    flowState: (): ReflectionFlowState => ({
      ...flow,
      workspaceSnapshot: workspace.toSnapshot({ excludeAssemblyStrings: true }),
    }),
    /** A round was entered: its media workspace starts empty. */
    resetWorkspace: (): void => {
      workspace = AgentWorkspaceState.create();
    },
    outputs: (): RoundOutput[] => roundsToPersisted(outputState),
  };
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
