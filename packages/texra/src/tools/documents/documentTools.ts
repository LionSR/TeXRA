/**
 * The document tools a document task's recipe (`./documentRecipe`) calls,
 * one step each over one revision of its run's documents (`./documents`):
 * the revision's prompt, the files its reply holds, their compile check,
 * their latexdiff, and the proposal the task ends with (a critic's review
 * of a revision is `./DocumentReviewTool`). Each reads the run's documents
 * from its rows and commits them again; none holds state between calls, so
 * a resumed recipe replays against the rows.
 */
// Node imports
import { dirname, join } from 'node:path';

// Third-party imports
import { Effect, Exit, FileSystem, Schema } from 'effect';

import {
  boundFile,
  ChildRuns,
  requireRun,
  executed,
  ToolError,
  defineTool,
  Settings,
} from '@texra-ai/harness/plugins';
import {
  fileLocationDisplayPath,
  MESSAGE_TYPES,
  outcomeFromCause,
  RUN_OUTCOME,
  RunIdSchema,
  toErrorMessage,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import {
  documentsOutputFact,
  documentTaskOptions,
} from '@texra/shared/plugins/documents';
import { runCompileCheck } from '@texra/agent/output/compileCheck';
import { extractFilesFromXml } from '@texra/agent/output/outputFileExtraction';
import { recoverOutputFailure } from '@texra/agent/output/outputOperations';
import { computeOutputDiffStats } from '@texra/agent/output/diffComputation';
import { revisionLatexdiffs } from '@texra/agent/output/revisionLatexdiffs';
import { ensureCorrectXmlStructure } from '@texra/agent/output/replyDocuments';
import { revisionLayout } from '@texra/shared/constants/revisionLayout';
import {
  keepReply,
  openDocuments,
  revisionPrompt,
  roundOf,
  withRound,
  type Documents,
} from '@texra/tools/documents/documentState';
import { computeDocumentDiffs } from '@texra/tools/documents/documentResult';
import { rejectOversizedBibAttachments } from '@texra/tools/documents/documentTask';
import {
  compileFailuresOf,
  latexdiffDisplayName,
  roundOutputsToOutputSummaries,
  OUTPUT_END_TAG,
  type CompileOutcome,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import {
  DOCUMENTS_OPEN_PDF_SETTING,
  DOCUMENTS_REJECT_ON_COMPILE_FAILURE_SETTING,
} from '@texra/shared/settingsView/documentsSettings';

/** A revision of a document task, by its zero-based index. */
export const RevisionSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
).annotate({
  description: 'The revision, from 0, in the order the task runs them.',
});

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
      docs.requests.present('openFile', {
        location,
        preserveFocus: true,
      }),
    { discard: true },
  );

const autoOpensPdf = (docs: Documents) =>
  Settings.get(docs.deps.roots, DOCUMENTS_OPEN_PDF_SETTING);

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
  // not, though it exists. Why it did not read is kept for the refusal. The
  // probe checks the type and the permission; the bytes are read later.
  const located = (files: readonly string[]) =>
    Effect.forEach(
      files.filter(Boolean),
      (file) => {
        const absolutePath = fileService.locateSource(file).absolutePath;
        return fs.stat(absolutePath).pipe(
          Effect.flatMap((info) =>
            info.type === 'File'
              ? fs.access(absolutePath, { readable: true })
              : Effect.fail(new Error(`not a file (${info.type})`)),
          ),
          Effect.match({
            onSuccess: () => ({ path: file, absolutePath, error: null }),
            onFailure: (error) => ({
              path: file,
              absolutePath,
              error: toErrorMessage(error),
            }),
          }),
          Effect.map((read) => ({ ...read, ok: read.error === null })),
        );
      },
      { concurrency: 8 },
    );
  const inputs = yield* located([...config.inputFiles, ...config.mediaFiles]);
  const unreadable = inputs.filter((input) => !input.ok);
  if (inputs.length === 0 || unreadable.length > 0)
    return yield* Effect.fail(
      new ToolError(
        `The document task of '${config.agent}' needs readable inputFiles or mediaFiles (its result carries output files and diffs, not response text): ${
          unreadable.length > 0
            ? `cannot read ${unreadable.map((input) => `${input.path} (${input.error})`).join(', ')}.`
            : 'it has none.'
        }`,
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
  // One files-loaded card per category, its label each file's source.
  const logCategory = (category: string, files: typeof inputs) => {
    if (files.length === 0) return;
    const data = files.map(({ path, ok }) => ({
      path,
      ok,
      source: category,
      sourceDisplay: category,
    }));
    logger.info('', { messageType: MESSAGE_TYPES.FILE_LIST, data, stageId });
  };
  logCategory('Input Files', inputs);
  logCategory('Context Files', contexts);
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
  schema: Schema.Struct({
    revision: RevisionSchema,
    critique: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description: "The critic's review of the last revision.",
    }),
  }),
  execute: Effect.fn('document_context')(function* ({ revision, critique }) {
    const docs = yield* documentsOfCall('document_context');
    if (revision !== 0)
      return yield* revisionContext(docs, revision, critique, undefined);
    // The first revision's checks and file cards nest under a stage that
    // closes with the call, on the call's own outcome.
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => docs.run.logger.openStage('Revision 1')),
      (stage) => revisionContext(docs, revision, critique, stage.id),
      (stage, exit) =>
        Effect.sync(() =>
          stage.end(
            Exit.match(exit, {
              onSuccess: (result) =>
                result.status === 'error'
                  ? RUN_OUTCOME.FAILED
                  : RUN_OUTCOME.COMPLETED,
              onFailure: outcomeFromCause,
            }),
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
  const revised = yield* revisionPrompt(docs, revision, critique);
  if (stageId !== undefined && revised.loaded.length > 0)
    docs.run.logger.info('', {
      messageType: MESSAGE_TYPES.FILE_LIST,
      data: revised.loaded,
      stageId,
    });
  const { prompt } = revised;
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
  schema: Schema.Struct({
    revision: RevisionSchema,
    run: RunIdSchema.annotate({ description: "The revision's agent run." }),
  }),
  execute: Effect.fn('document_extract')(function* ({ revision, run }) {
    const docs = yield* documentsOfCall('document_extract');
    const end = yield* (yield* ChildRuns).records(run).end;
    // TeXRA's LaTeX replacements over the provider text, with the rules of
    // the workspace this run belongs to.
    const replaced = replacementEngine.applyAll(
      end?.output.response ?? '',
      docs.deps.roots.config,
    );
    yield* logReplacementDiagnostics(replaced.diagnostics);
    const reply = replaced.text;
    if (end?.outcome !== 'completed' || !reply.trim())
      return yield* Effect.fail(
        new ToolError(`Run ${run} gave no reply to take documents from.`),
      );
    const { logger, fileService, roots } = docs.deps;
    const location = yield* keepReply(docs, revision, reply);
    // A broken structure costs the repair, not the revision: reported, and
    // extraction reads the reply as it is.
    yield* ensureCorrectXmlStructure(location, roots.config, logger).pipe(
      recoverOutputFailure({
        logger,
        label: 'XML structure',
        recover: () => Effect.void,
      }),
    );
    const extracted = yield* extractFilesFromXml(
      docs.deps,
      location,
      revision,
      roundOf(docs.rounds, revision - 1)?.outputs ?? [],
    );
    const outputs = yield* computeOutputDiffStats(
      extracted.outputs,
      roots.workspace,
      docs.baseFiles,
      // A task that names no outputs rewrites its inputs: its outputs descend
      // from them, even when a launch names where they are written.
      docs.task.outputs.length === 0,
    );
    // Without the model's version, a later Accept cannot tell the model
    // what the user changed: reported, and the revision keeps its outputs.
    yield* Effect.forEach(
      outputs,
      Effect.fnUntraced(function* ({ round: outputRound, location }) {
        const copyPath = revisionLayout(outputRound).modelCopy(location);
        if (copyPath === undefined) return;
        const fs = yield* FileSystem.FileSystem;
        const copy = join(fileService.runDirectory, copyPath);
        yield* fs.makeDirectory(dirname(copy), { recursive: true });
        yield* fs.copyFile(location.absolutePath, copy);
      }),
      { discard: true },
    ).pipe(
      recoverOutputFailure({
        logger,
        label: "Keeping the model's outputs",
        recover: () => Effect.void,
      }),
    );
    // The revision anew: what an earlier attempt of it recorded is replaced.
    const round: RoundOutput = {
      round: revision,
      outputs,
      missingOutputs: extracted.missing,
      compile: null,
      latexdiffs: [],
      reply: location,
    };
    const missing = round.missingOutputs;
    if (missing.length > 0)
      yield* docs.requests.present('requestShowInstruction', {
        key: 'missingOutputsInfo',
        message: 'Missing output files detected',
      });
    // An open reply was cut off: the model hit its output limit.
    const truncated = reply.includes(OUTPUT_END_TAG)
      ? undefined
      : `Revision ${revision + 1} did not close its documents, so its output may be incomplete. Raise the model's max output tokens to let it finish.`;
    if (truncated !== undefined) {
      logger.warn(truncated);
      yield* docs.requests.present('requestShowInstruction', {
        key: 'roundOutputLimit',
        message: truncated,
      });
    }
    yield* present(
      docs,
      outputs.map((output) => output.location),
    );
    const files = outputs.map((output) =>
      fileLocationDisplayPath(output.location),
    );
    return {
      ...executed(
        (files.length > 0
          ? `Revision ${revision + 1} wrote: ${files.join(', ')}.`
          : `Revision ${revision + 1} wrote no documents.`) +
          (missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : '') +
          (truncated === undefined ? '' : ` ${truncated}`),
        `Revision ${revision + 1}: ${files.length} files`,
      ),
      value: { files, missing },
      facts: [documentsOutputFact(withRound(docs.rounds, round))],
    };
  }),
});

/** `document_compile`: the compile check over a revision's outputs. */
export const DocumentCompileTool = defineTool({
  name: 'document_compile',
  description:
    "Compile a revision's .tex outputs. Resolves to `{ failures, skipped, rejected }`: the outputs that failed with their logs; why no check ran (auto-compile is off, no .tex output, no LaTeX compiler, or the check failed), else null; and whether the failures reject the revision, which the next revision's prompt and `document_propose` act on. Run it before `document_diff`, not beside it: each call records the run's documents whole.",
  scriptReturns:
    '{ failures: { output: string; log: string }[]; skipped: string | null; rejected: boolean }',
  replay: 'safe',
  schema: Schema.Struct({ revision: RevisionSchema }),
  execute: Effect.fn('document_compile')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_compile');
    const { roots, fileService, logger } = docs.deps;
    const recorded = roundOf(docs.rounds, revision);
    // The compile searches where the task's bound files live (`task.files`,
    // read from beside its agent file), so a template's theme files resolve
    // as they do for the prompt.
    const inputDirs = [
      ...new Set(
        Object.values(docs.task.files)
          .filter((file): file is string => Boolean(file))
          .map((file) => dirname(boundFile(docs.entry.path, file).path)),
      ),
    ];
    const check = yield* runCompileCheck(
      { roots, fileService, logger, runId: docs.run.runId, inputDirs },
      revision,
      recorded?.outputs ?? [],
    ).pipe(
      // A check that could not run (an unreadable setting) checked nothing.
      recoverOutputFailure({
        logger,
        label: 'Compile check',
        recover: () =>
          Effect.succeed({
            _tag: 'skipped' as const,
            reason: 'the check itself failed',
            unverified: true,
          }),
      }),
    );
    // What a failed compile means for the task is decided here, once, and
    // recorded with the revision.
    const rejects = yield* Settings.get(
      roots,
      DOCUMENTS_REJECT_ON_COMPILE_FAILURE_SETTING,
    );
    const compile: CompileOutcome =
      check._tag === 'skipped'
        ? { _tag: 'skipped', reason: check.reason }
        : {
            _tag: 'checked',
            failures: check.failures,
            rejected: rejects && check.failures.length > 0,
          };
    const failures = compileFailuresOf({ compile });
    // A revision with no record extracted nothing, so its check checked
    // nothing and records nothing.
    const facts =
      recorded === undefined
        ? []
        : [
            documentsOutputFact(
              withRound(docs.rounds, { ...recorded, compile }),
            ),
          ];
    if (yield* autoOpensPdf(docs))
      yield* present(
        docs,
        check._tag === 'skipped'
          ? []
          : failures.length > 0
            ? failures.map((f) => f.log)
            : check.artifacts,
      );
    const summary = failures.map((failure) => ({
      output: failure.displayName,
      log: failure.logRelativePath,
    }));
    const value = {
      failures: summary,
      skipped: compile._tag === 'skipped' ? compile.reason : null,
      rejected: compile._tag === 'checked' && compile.rejected,
    };
    if (check._tag === 'skipped') {
      // The rejection gate sees no failures here, so it says what it skips:
      // a check that had something to compile and could not.
      const unverified =
        rejects && check.unverified
          ? ' Failed compiles are rejected, but this revision is unverified.'
          : '';
      return {
        ...executed(
          `No compile check ran: ${check.reason}.${unverified}`,
          'Not checked',
        ),
        value,
        facts,
      };
    }
    let message = `Revision ${revision + 1} compiles.`;
    if (failures.length > 0)
      message = `Revision ${revision + 1} failed to compile: ${summary.map((f) => `${f.output} (${f.log})`).join(', ')}`;
    return {
      ...executed(
        message,
        failures.length === 0 ? 'Compiles' : `${failures.length} failed`,
      ),
      value,
      facts,
    };
  }),
});

/** `document_diff`: latexdiff of a revision's outputs against the base. */
export const DocumentDiffTool = defineTool({
  name: 'document_diff',
  description:
    "Run latexdiff of a revision's outputs against the documents the task started from. Resolves to `{ diffs, failed, notRun }`: the diff files it wrote, the documents whose diff failed with why (latexdiff not installed among them), and why no diff ran at all (no outputs, or the pass failed), else null. Run it after `document_compile`, not beside it: each call records the run's documents whole.",
  scriptReturns:
    '{ diffs: string[]; failed: { document: string; error: string }[]; notRun: string | null }',
  replay: 'safe',
  schema: Schema.Struct({ revision: RevisionSchema }),
  execute: Effect.fn('document_diff')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_diff');
    const recorded = roundOf(docs.rounds, revision);
    const outputs = recorded?.outputs ?? [];
    if (recorded === undefined || outputs.length === 0)
      return {
        ...executed(
          `Revision ${revision + 1} has no outputs to diff.`,
          'Nothing to diff',
        ),
        value: { diffs: [], failed: [], notRun: null },
      };
    const { artifacts, entries, notRun } = yield* revisionLatexdiffs(
      docs.deps,
      revision,
      outputs,
      roundOf(docs.rounds, revision - 1)?.outputs ?? [],
    );
    if (yield* autoOpensPdf(docs)) yield* present(docs, artifacts);
    const diffs = entries.flatMap((entry) =>
      entry.status === 'ok' ? [fileLocationDisplayPath(entry.diff)] : [],
    );
    const failed = entries.flatMap((entry) =>
      entry.status === 'failed'
        ? [{ document: latexdiffDisplayName(entry), error: entry.error }]
        : [],
    );
    const pdfs = artifacts.map(fileLocationDisplayPath);
    // What the model reads: the diffs, each failed pair with its error, and
    // why no pair ran, each said apart from a revision with nothing to diff.
    let lines = [`Revision ${revision + 1} has no document pairs to diff.`];
    let summary = `${diffs.length} diffs`;
    if (notRun !== null) {
      lines = [`No diffs for revision ${revision + 1}: ${notRun}.`];
      summary = 'No diffs ran';
    } else if (entries.length > 0) {
      lines = [
        diffs.length > 0 ? `Diffs: ${diffs.join(', ')}.` : 'No diffs written.',
        ...(pdfs.length > 0 ? [`Diff PDFs: ${pdfs.join(', ')}.`] : []),
        ...failed.map((f) => `Diff failed for ${f.document}: ${f.error}`),
      ];
      if (failed.length > 0) summary += `, ${failed.length} failed`;
    }
    return {
      ...executed(lines.join('\n'), summary),
      value: { diffs, failed, notRun },
      facts: [
        documentsOutputFact(
          withRound(docs.rounds, { ...recorded, latexdiffs: entries }),
        ),
      ],
    };
  }),
});

/**
 * `document_propose`: the task's result, the outputs of its latest revision
 * that wrote any. That revision failing its compile fails the task when its
 * check recorded the failure as a rejection.
 */
export const DocumentProposeTool = defineTool({
  name: 'document_propose',
  description:
    "End the document task: propose the outputs of its latest revision that wrote any for the user to accept, with their diffs against the documents they started from. Fails, naming the failed outputs, when that revision did not compile and failed compiles are rejected. Resolves to `{ files }`, the proposed files; the task's documents, diffs included, are what its run reports.",
  scriptReturns: '{ files: string[] }',
  replay: 'safe',
  schema: Schema.Struct({}),
  execute: Effect.fn('document_propose')(function* () {
    const docs = yield* documentsOfCall('document_propose');
    const last = docs.rounds.findLast((round) => round.outputs.length > 0);
    if (last === undefined)
      return yield* Effect.fail(
        new ToolError('The task produced no documents to propose.'),
      );
    if (last.compile?._tag === 'checked' && last.compile.rejected)
      return yield* Effect.fail(
        new ToolError(
          `The documents of the last revision did not compile: ${last.compile.failures.map((f) => `${f.displayName} (${f.logRelativePath})`).join(', ')}.`,
        ),
      );
    const files = last.outputs.map((output) =>
      fileLocationDisplayPath(output.location),
    );
    // The proposed revision's diffs, written beside the outputs: the
    // documents fact records them, and the task's result is read from that
    // fact (`DOCUMENT_TASK_RESULT`). Still `replay: 'safe'`: the `.diff` files are deterministic
    // overwrites under fixed run-relative names from fixed inputs, and the
    // fact commits with this call's result, so a rerun after a crash
    // rewrites the same files and commits the fact once.
    const diffs = yield* computeDocumentDiffs(
      docs.deps.roots.storage,
      docs.run.runId,
      roundOutputsToOutputSummaries([last]),
    );
    const fact = documentsOutputFact(docs.rounds, diffs);
    return {
      ...executed(`Proposed: ${files.join(', ')}`, `${files.length} documents`),
      value: { files },
      facts: [fact],
    };
  }),
});
