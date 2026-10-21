/**
 * The document tools a document task's recipe (`./documentRecipe`) calls,
 * one step each over one revision of its run's documents (`./documents`):
 * the revision's prompt, the files its reply holds, their compile check,
 * their latexdiff, and the proposal the task ends with (a critic's review
 * of a revision is `./DocumentReviewTool`). Each reads the run's documents
 * from its rows and commits them again; none holds state between calls, so
 * a resumed recipe replays against the rows.
 */
import { Cause, Effect, Exit, FileSystem } from 'effect';
import { z } from 'zod';

import { defineTool } from '@texra-ai/harness';
import {
  ChildRuns,
  requireRun,
  executed,
  ToolError,
} from '@texra-ai/harness/plugins';
import { Settings } from '@texra-ai/harness';
import {
  fileLocationDisplayPath,
  RUN_OUTCOME,
  RunIdSchema,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import { logFileCategory, logFilesLoaded } from '@agent/trace';
import { postProcessResponse } from '@latex/texraResponseTextProcessing';
import {
  documentsSummary,
  documentTaskOptions,
} from '@texra/shared/plugins/documents';
import { runCompileCheck } from '@texra/agent/output/compileCheck';
import { traceFileLineage } from '@texra/agent/output/lineageMapping';
import { extractFilesFromXml } from '@texra/agent/output/outputFileExtraction';
import { recoverOutputFailure } from '@texra/agent/output/outputOperations';
import {
  ensureRoundData,
  roundsToPersisted,
  setCompileFailures,
} from '@texra/agent/output/outputState';
import { checkExpectedOutputs } from '@texra/agent/output/outputValidation';
import { computeOutputDiffStats } from '@texra/agent/output/diffComputation';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import {
  keepReply,
  openDocuments,
  rejectsOnCompileFailure,
  revisionPrompt,
  type Documents,
} from '@texra/tools/documents/documentState';
import { computeDocumentDiffs } from '@texra/tools/documents/documentResult';
import { rejectOversizedBibAttachments } from '@texra/tools/documents/documentTask';
import {
  roundOutputsToOutputSummaries,
  OUTPUT_END_TAG,
} from '@texra/shared/plugins/documentOutputs';

/** A revision of a document task, by its zero-based index. */
export const RevisionSchema = z
  .int()
  .nonnegative()
  .describe('The revision, from 0, in the order the task runs them.');

/** The documents of the run the calling tool `tool` serves. */
export const documentsOfCall = Effect.fn('documents.ofCall')(function* (
  tool: string,
) {
  return yield* openDocuments(yield* requireRun(tool));
});

/** Open `locations` for the user, beside what they are looking at. */
const present = (docs: Documents, locations: readonly FileLocation[]) =>
  Effect.forEach(
    locations,
    (location) =>
      docs.requests.present('requestOpenFile', {
        location,
        preserveFocus: true,
      }),
    { discard: true },
  );

const autoOpensPdf = (docs: Documents) =>
  Settings.get<boolean>(
    docs.deps.roots,
    DocumentsStateKey.WORKFLOW_AUTO_OPEN_PDF,
  );

/**
 * What the first revision checks before the task does any work, whichever
 * launcher or resume reached it: the documents it revises exist, and no
 * context `.bib` is too large to attach whole. It writes the files-loaded
 * cards of the task's inputs and context under `stageId` (its template
 * files' card comes with the revision's prompt, which reads them). An error
 * result fails the call, and with it the task.
 */
const openTask = Effect.fn('documents.openTask')(function* (
  docs: Documents,
  stageId: string,
) {
  const { config, logger } = docs.run;
  const { fileService } = docs.deps;
  const fs = yield* FileSystem.FileSystem;
  // A file is loaded when it reads: a directory or an unreadable path is
  // not, though it exists.
  const located = (files: readonly string[]) =>
    Effect.forEach(files.filter(Boolean), (file) => {
      const absolutePath = fileService.locateSource(file).absolutePath;
      return Effect.map(
        fs.readFile(absolutePath).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
        (ok) => ({ path: file, absolutePath, ok }),
      );
    });
  const inputs = yield* located([...config.inputFiles, ...config.mediaFiles]);
  if (inputs.length === 0 || inputs.some((input) => !input.ok))
    return yield* Effect.fail(
      new ToolError(
        `The document task of '${config.agent}' needs readable inputFiles or mediaFiles (its result carries output files and diffs, not response text).`,
      ),
    );
  const contexts = yield* located(config.contextFiles);
  // A missing context file is skipped, as the prompt skips it; only the
  // files found are measured.
  const oversized = yield* rejectOversizedBibAttachments(
    docs.deps.roots.workspace,
    contexts.filter((context) => context.ok).map((c) => c.absolutePath),
  );
  if (oversized) return oversized;
  logFileCategory(logger, 'Input Files', inputs, stageId);
  logFileCategory(logger, 'Context Files', contexts, stageId);
  return null;
});

/** `document_context`: the prompt and media of one revision. */
export const DocumentContextTool = defineTool({
  name: 'document_context',
  description:
    "A document task's revision prompt: the task's documents, every earlier request with the reply it got, and this revision's request with the compile failures that rejected the last one and the `critique` of it, if any. Resolves to `{ prompt, mediaFiles, memories, revisions, reflect }`: `memories` are the launch's, for the revision's agent; `reflect` says the task reviews each revision but the last (`document_review`).",
  scriptReturns:
    '{ prompt: string; mediaFiles: string[]; memories: string[]; revisions: number; reflect: boolean }',
  replay: 'safe',
  schema: z.strictObject({
    revision: RevisionSchema,
    critique: z
      .string()
      .nullish()
      .describe("The critic's review of the last revision."),
  }),
  execute: Effect.fn('document_context')(function* ({ revision, critique }) {
    const docs = yield* documentsOfCall('document_context');
    // The first revision's checks and file cards nest under a stage of the
    // run's own, closed with the call.
    const stage =
      revision === 0 ? docs.run.parentStage.child('Revision 1') : null;
    return yield* revisionContext(docs, revision, critique, stage?.id).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          stage?.end(
            Exit.isSuccess(exit) && exit.value.status !== 'error'
              ? RUN_OUTCOME.COMPLETED
              : RUN_OUTCOME.FAILED,
          ),
        ),
      ),
    );
  }),
});

/** The prompt and media of `revision`, after the first revision's checks
 *  (`openTask`) when `stageId` is its stage. */
const revisionContext = Effect.fn('documents.revisionContext')(function* (
  docs: Documents,
  revision: number,
  critique: string | null | undefined,
  stageId: string | undefined,
) {
  if (stageId !== undefined) {
    const refused = yield* openTask(docs, stageId);
    if (refused) return refused;
  }
  const revisions = docs.task.requests.length;
  if (revision >= revisions)
    return yield* Effect.fail(
      new ToolError(
        `The task has ${revisions} revisions; revision ${revision} is not one of them.`,
      ),
    );
  const revised = yield* revisionPrompt(docs, revision);
  if (stageId !== undefined && revised.loaded.length > 0)
    logFilesLoaded(docs.run.logger, revised.loaded, stageId);
  // The critic's review of the last revision, after this one's request.
  const prompt = critique?.trim()
    ? `${revised.prompt}\n\nA reviewer read your last revision. Apply the corrections that hold, and the suggested improvement where it serves this request:\n<critique revision="${revision}">\n${critique.trim()}\n</critique>`
    : revised.prompt;
  return {
    ...executed(prompt, `Revision ${revision + 1} of ${revisions}`),
    value: {
      prompt,
      mediaFiles: revised.media,
      memories: docs.run.config.memories,
      revisions,
      reflect: documentTaskOptions(docs.run.config).reflect,
    },
  };
});

/** `document_extract`: the files a revision's reply holds. */
export const DocumentExtractTool = defineTool({
  name: 'document_extract',
  description:
    "Take the documents out of the reply a revision's agent run gave (`run`, the run id `agent()` resolved with): they become the revision's output files, with their lineage and diff stats. Resolves to `{ files, missing }`: `missing` names the expected files the revision lacks, and `<unextracted document N>` for each document its reply held that did not extract.",
  scriptReturns: '{ files: string[]; missing: string[] }',
  replay: 'safe',
  schema: z.strictObject({
    revision: RevisionSchema,
    run: RunIdSchema.describe("The revision's agent run."),
  }),
  execute: Effect.fn('document_extract')(function* ({ revision, run }) {
    const docs = yield* documentsOfCall('document_extract');
    const end = yield* (yield* ChildRuns).records(run).end;
    // The host's cleanup of provider text (TeXRA's LaTeX replacements).
    const reply = yield* postProcessResponse(
      end?.output.response ?? '',
      docs.deps.roots.config,
    );
    if (end?.outcome !== 'completed' || !reply.trim())
      return yield* Effect.fail(
        new ToolError(`Run ${run} gave no reply to take documents from.`),
      );
    const { logger } = docs.deps;
    const location = yield* keepReply(docs, revision, reply);
    // Clear what an earlier attempt of this revision extracted.
    const round = ensureRoundData(docs.state, revision);
    round.outputs = [];
    round.missingOutputs = [];
    round.compileFailures = [];
    round.latexdiffs = [];
    round.reply = location;
    // A broken structure costs the repair, not the revision: reported, and
    // extraction reads the reply as it is.
    yield* docs.xml.ensureCorrectXmlStructure(location).pipe(
      recoverOutputFailure({
        logger,
        level: 'warn',
        label: 'XML structure',
        recover: () => Effect.void,
      }),
    );
    yield* extractFilesFromXml(
      docs.state,
      docs.deps,
      docs.xml,
      location,
      revision,
    );
    round.outputs = yield* computeOutputDiffStats(
      docs.state,
      docs.deps.roots.workspace,
      docs.baseFiles,
      revision,
      docs.task.rewrite,
    );
    checkExpectedOutputs(docs.state, docs.deps, revision);
    const missing = round.missingOutputs;
    if (missing.length > 0)
      yield* docs.requests.present('requestShowInstruction', {
        key: 'missingOutputsInfo',
        message: 'Missing output files detected',
      });
    // An open reply was cut off: the model hit its output limit.
    if (!reply.includes(OUTPUT_END_TAG)) {
      const message = `Revision ${revision + 1} did not close its documents, so its output may be incomplete. Raise the model's max output tokens to let it finish.`;
      logger.warn(message);
      yield* docs.requests.present('requestShowInstruction', {
        key: 'roundOutputLimit',
        message,
      });
    }
    yield* present(
      docs,
      round.outputs.map((output) => output.location),
    );
    const files = round.outputs.map((output) =>
      fileLocationDisplayPath(output.location),
    );
    return {
      ...executed(
        (files.length > 0
          ? `Revision ${revision + 1} wrote: ${files.join(', ')}`
          : `Revision ${revision + 1} wrote no documents.`) +
          (missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : ''),
        `Revision ${revision + 1}: ${files.length} files`,
      ),
      value: { files, missing },
      facts: [docs.fact()],
    };
  }),
});

/** `document_compile`: the compile check over a revision's outputs. */
export const DocumentCompileTool = defineTool({
  name: 'document_compile',
  description:
    "Compile a revision's .tex outputs. Resolves to `{ failures, checked }`: the outputs that failed with their logs, and whether a check ran at all (auto-compile off, or no LaTeX toolchain, runs none). Run it before `document_diff`, not beside it: each call records the run's documents whole.",
  scriptReturns:
    '{ failures: { output: string; log: string }[]; checked: boolean }',
  replay: 'safe',
  schema: z.strictObject({ revision: RevisionSchema }),
  execute: Effect.fn('document_compile')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_compile');
    const { roots, fileService, logger } = docs.deps;
    const check = yield* runCompileCheck(
      {
        roots,
        fileService,
        outputState: docs.state,
        logger,
        runId: docs.run.runId,
      },
      revision,
    ).pipe(
      // A check that could not run (an unreadable setting) checked nothing.
      recoverOutputFailure({
        logger,
        level: 'warn',
        label: 'Compile check',
        recover: () => Effect.succeed({ artifacts: [], failures: undefined }),
      }),
    );
    const failures = check.failures ?? [];
    setCompileFailures(docs.state, revision, failures);
    if (yield* autoOpensPdf(docs))
      yield* present(
        docs,
        failures.length > 0 ? failures.map((f) => f.log) : check.artifacts,
      );
    const summary = failures.map((failure) => ({
      output: failure.displayName,
      log: failure.logRelativePath,
    }));
    let message = `Revision ${revision + 1} compiles.`;
    if (check.failures === undefined) message = 'No compile check ran.';
    else if (failures.length > 0)
      message = `Revision ${revision + 1} failed to compile: ${summary.map((f) => `${f.output} (${f.log})`).join(', ')}`;
    return {
      ...executed(
        message,
        failures.length === 0 ? 'Compiles' : `${failures.length} failed`,
      ),
      value: { failures: summary, checked: check.failures !== undefined },
      facts: [docs.fact()],
    };
  }),
});

/** `document_diff`: latexdiff of a revision's outputs against the base. */
export const DocumentDiffTool = defineTool({
  name: 'document_diff',
  description:
    "Run latexdiff of a revision's outputs against the documents the task started from. Resolves to `{ diffs }`, the diff files it wrote. Run it after `document_compile`, not beside it: each call records the run's documents whole.",
  scriptReturns: '{ diffs: string[] }',
  replay: 'safe',
  schema: z.strictObject({ revision: RevisionSchema }),
  execute: Effect.fn('document_diff')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_diff');
    const outputs = docs.state.rounds.get(revision)?.outputs ?? [];
    if (outputs.length === 0)
      return {
        ...executed(
          `Revision ${revision + 1} has no outputs to diff.`,
          'Nothing to diff',
        ),
        value: { diffs: [] },
      };
    const { artifacts, entries } = yield* docs.diff
      .handleLatexdiffOfOutput(
        revision,
        outputs,
        traceFileLineage(docs.state, docs.baseFiles, revision),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => {
                docs.deps.logger.warn('latexdiff failed', {
                  data: Cause.squash(cause),
                });
                return { artifacts: [], entries: [] };
              }),
        ),
      );
    ensureRoundData(docs.state, revision).latexdiffs = entries;
    if (yield* autoOpensPdf(docs)) yield* present(docs, artifacts);
    const diffs = artifacts.map(fileLocationDisplayPath);
    return {
      ...executed(
        diffs.length > 0 ? `Diffs: ${diffs.join(', ')}` : 'No diffs written.',
        `${diffs.length} diffs`,
      ),
      value: { diffs },
      facts: [docs.fact()],
    };
  }),
});

/**
 * `document_propose`: the task's result, the outputs of its latest revision
 * that wrote any. That revision failing its compile fails the task while
 * the setting rejects on compile failures.
 */
export const DocumentProposeTool = defineTool({
  name: 'document_propose',
  description:
    "End the document task: propose the outputs of its latest revision that wrote any for the user to accept, with their diffs against the documents they started from. Fails, naming the failed outputs, when that revision did not compile and failed compiles are rejected. Resolves to `{ files, documents }`: the proposed files and every revision's documents with the proposed ones' diffs, which the task's run ends with.",
  scriptReturns: '{ files: string[]; documents: unknown }',
  replay: 'safe',
  schema: z.strictObject({}),
  execute: Effect.fn('document_propose')(function* () {
    const docs = yield* documentsOfCall('document_propose');
    const rounds = roundsToPersisted(docs.state);
    const last = rounds.findLast((round) => round.outputs.length > 0);
    if (last === undefined)
      return yield* Effect.fail(
        new ToolError('The task produced no documents to propose.'),
      );
    if (
      last.compileFailures.length > 0 &&
      (yield* rejectsOnCompileFailure(docs))
    )
      return yield* Effect.fail(
        new ToolError(
          `The documents of the last revision did not compile: ${last.compileFailures.map((f) => `${f.displayName} (${f.logRelativePath})`).join(', ')}.`,
        ),
      );
    const files = last.outputs.map((output) =>
      fileLocationDisplayPath(output.location),
    );
    // The proposed revision's diffs, written beside the outputs: the
    // documents fact records them, and the task's result is read from that
    // fact. Still `replay: 'safe'`: the `.diff` files are deterministic
    // overwrites under fixed run-relative names from fixed inputs, and the
    // fact commits with this call's result, so a rerun after a crash
    // rewrites the same files and commits the fact once.
    const diffs = yield* computeDocumentDiffs(
      docs.deps.roots.storage,
      docs.run.runId,
      roundOutputsToOutputSummaries([last]),
    );
    const fact = docs.fact(diffs);
    return {
      ...executed(`Proposed: ${files.join(', ')}`, `${files.length} documents`),
      value: { files, documents: documentsSummary(fact) },
      facts: [fact],
    };
  }),
});
