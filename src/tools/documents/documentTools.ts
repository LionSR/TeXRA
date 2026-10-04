/**
 * The document tools a document task's recipe (`./documentRecipe`) calls,
 * one step each over one revision of its run's documents (`./documents`):
 * the revision's prompt, the files its reply holds, their compile check,
 * their latexdiff, and the proposal the task ends with. Each reads the run's
 * documents from its rows and commits them again; none holds state between
 * calls, so a resumed recipe replays against the rows.
 */
import { Cause, Effect } from 'effect';
import { z } from 'zod';

import { getRunRecords } from '@agent/storage';
import { compileFailuresOf, runCompileCheck } from '@agent/output/compileCheck';
import { traceFileLineage } from '@agent/output/lineageMapping';
import { extractFilesFromXml } from '@agent/output/outputFileExtraction';
import { recoverOutputFailure } from '@agent/output/outputOperations';
import {
  ensureRoundData,
  roundsToPersisted,
  setCompileFailures,
} from '@agent/output/outputState';
import { checkExpectedOutputs } from '@agent/output/outputValidation';
import { summarizeRound } from '@agent/output/roundSummary';
import { ToolCall } from '@agent/runtime/ToolCall';
import { documentsSummary } from '@shared/plugins/documents';
import {
  fileLocationDisplayPath,
  OUTPUT_END_TAG,
  RunIdSchema,
  ToolError,
  type FileLocation,
} from '@shared/schemas';
import { DocumentsStateKey } from '@shared/settingsView/documentsSettings';
import {
  keepReply,
  openDocuments,
  rejectsOnCompileFailure,
  revisionPrompt,
  type Documents,
} from '@tools/documents/documentState';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { requireToolRun } from '@tools/core/toolRun';
import { readSettingFrom } from '@utils/config/platformSettings';

const RevisionSchema = z
  .int()
  .nonnegative()
  .describe('The revision, from 0, in the order the task runs them.');

/** The documents of the run the calling tool serves. */
const documentsOfCall = (tool: string) =>
  Effect.flatMap(ToolCall, (call) =>
    Effect.flatMap(requireToolRun(tool, call), ({ run }) => openDocuments(run)),
  );

/** A step whose failure costs that step, not the revision: reported at
 *  `warn` on the transcript, then the recipe carries on. */
const recoverWarn = (docs: Documents, label: string) =>
  recoverOutputFailure({
    logger: docs.deps.logger,
    level: 'warn' as const,
    label,
    recover: () => Effect.void,
  });

/** Open `locations` for the user, beside what they are looking at. */
const present = (docs: Documents, locations: readonly FileLocation[]) =>
  Effect.forEach(
    locations,
    (location) =>
      docs.run.session.interactions.emit('requestOpenFile', {
        location,
        preserveFocus: true,
      }),
    { discard: true },
  );

const autoOpensPdf = (docs: Documents) =>
  readSettingFrom<boolean>(
    docs.deps.roots,
    DocumentsStateKey.WORKFLOW_AUTO_OPEN_PDF,
  );

/** `document_context`: the prompt and media of one revision. */
export const DocumentContextTool = defineTool({
  name: 'document_context',
  description:
    "A document task's revision prompt: the task's documents, every earlier request with the reply it got, and this revision's request with the compile failures that rejected the last one. Resolves to `{ prompt, mediaFiles, memories, revisions }`: `memories` are the launch's, for the revision's agent.",
  scriptReturns:
    '{ prompt: string; mediaFiles: string[]; memories: string[]; revisions: number }',
  replay: 'safe',
  schema: z.strictObject({ revision: RevisionSchema }),
  execute: Effect.fn('document_context')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_context');
    const revisions = docs.task.requests.length;
    if (revision >= revisions)
      return yield* Effect.fail(
        new ToolError(
          `The task has ${revisions} revisions; revision ${revision} is not one of them.`,
        ),
      );
    const { prompt, media } = yield* revisionPrompt(docs, revision);
    return {
      ...executed(prompt, `Revision ${revision + 1} of ${revisions}`),
      value: {
        prompt,
        mediaFiles: media,
        memories: docs.run.config.memories,
        revisions,
      },
    };
  }),
});

/** `document_extract`: the files a revision's reply holds. */
export const DocumentExtractTool = defineTool({
  name: 'document_extract',
  description:
    "Take the documents out of the reply a revision's agent run gave (`run`, the run id `agent()` resolved with): they become the revision's output files, with their lineage and diff stats. Resolves to `{ files, missing }`.",
  scriptReturns: '{ files: string[]; missing: string[] }',
  replay: 'safe',
  schema: z.strictObject({
    revision: RevisionSchema,
    run: RunIdSchema.describe("The revision's agent run."),
  }),
  execute: Effect.fn('document_extract')(function* ({ revision, run }) {
    const docs = yield* documentsOfCall('document_extract');
    const { session } = docs.run;
    const end = yield* getRunRecords(session, run).readRunEnd();
    // The host's cleanup of provider text (TeXRA's LaTeX replacements).
    const reply = yield* session.responseTextProcessing.postProcessResponse(
      end?.output.response ?? '',
      session.roots.config,
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
    yield* docs.xml
      .ensureCorrectXmlStructure(location)
      .pipe(recoverWarn(docs, 'XML structure'));
    yield* extractFilesFromXml(
      docs.state,
      docs.deps,
      docs.xml,
      location,
      revision,
    ).pipe(recoverWarn(docs, 'Output processing'));
    const mapping =
      round.outputs.length > 0
        ? traceFileLineage(docs.state, docs.baseFiles, revision)
        : undefined;
    const summary = yield* summarizeRound(
      docs.state,
      docs.deps,
      location,
      revision,
      { mapping, isRewrite: docs.task.rewrite, baseFiles: docs.baseFiles },
    );
    const { missing } = yield* checkExpectedOutputs(
      docs.state,
      docs.deps,
      location,
      revision,
    );
    if (missing.length > 0)
      yield* session.interactions.emit('requestShowInstruction', {
        key: 'missingOutputsInfo',
        message: 'Missing output files detected',
      });
    // An open reply was cut off: the model hit its output limit.
    if (!reply.includes(OUTPUT_END_TAG)) {
      const message = `Revision ${revision + 1} did not close its documents, so its output may be incomplete. Raise the model's max output tokens to let it finish.`;
      logger.warn(message);
      yield* session.interactions.emit('requestShowInstruction', {
        key: 'roundOutputLimit',
        message,
      });
    }
    yield* docs.commit;
    yield* present(docs, summary.filesToOpen);
    const files = round.outputs.map((output) =>
      fileLocationDisplayPath(output.location),
    );
    return {
      ...executed(
        files.length > 0
          ? `Revision ${revision + 1} wrote: ${files.join(', ')}`
          : `Revision ${revision + 1} wrote no documents.`,
        `Revision ${revision + 1}: ${files.length} files`,
      ),
      value: { files, missing },
    };
  }),
});

/** `document_compile`: the compile check over a revision's outputs. */
export const DocumentCompileTool = defineTool({
  name: 'document_compile',
  description:
    "Compile a revision's .tex outputs. Resolves to `{ failures, checked }`: the outputs that failed with their logs, and whether a check ran at all (auto-compile off, or no LaTeX toolchain, runs none).",
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
        recover: () =>
          Effect.succeed({ artifacts: [], compileResult: undefined }),
      }),
    );
    const failures = compileFailuresOf(check.compileResult);
    setCompileFailures(docs.state, revision, failures);
    yield* docs.commit;
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
    if (check.compileResult === undefined) message = 'No compile check ran.';
    else if (failures.length > 0)
      message = `Revision ${revision + 1} failed to compile: ${summary.map((f) => `${f.output} (${f.log})`).join(', ')}`;
    return {
      ...executed(
        message,
        failures.length === 0 ? 'Compiles' : `${failures.length} failed`,
      ),
      value: { failures: summary, checked: check.compileResult !== undefined },
    };
  }),
});

/** `document_diff`: latexdiff of a revision's outputs against the base. */
export const DocumentDiffTool = defineTool({
  name: 'document_diff',
  description:
    "Run latexdiff of a revision's outputs against the documents the task started from. Resolves to `{ diffs }`, the diff files it wrote.",
  scriptReturns: '{ diffs: string[] }',
  replay: 'safe',
  schema: z.strictObject({ revision: RevisionSchema }),
  execute: Effect.fn('document_diff')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_diff');
    if ((docs.state.rounds.get(revision)?.outputs.length ?? 0) === 0)
      return {
        ...executed(
          `Revision ${revision + 1} has no outputs to diff.`,
          'Nothing to diff',
        ),
        value: { diffs: [] },
      };
    const artifacts = yield* docs.diff
      .handleLatexdiffOfOutput(
        revision,
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
                return [];
              }),
        ),
      );
    if (yield* autoOpensPdf(docs)) yield* present(docs, artifacts);
    const diffs = artifacts.map(fileLocationDisplayPath);
    return {
      ...executed(
        diffs.length > 0 ? `Diffs: ${diffs.join(', ')}` : 'No diffs written.',
        `${diffs.length} diffs`,
      ),
      value: { diffs },
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
    "End the document task: propose the outputs of its latest revision that wrote any for the user to accept. Fails, naming the failed outputs, when that revision did not compile and failed compiles are rejected. Resolves to `{ files, documents }`: the proposed files and every revision's documents, which the task's run ends with.",
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
    return {
      ...executed(`Proposed: ${files.join(', ')}`, `${files.length} documents`),
      value: { files, documents: documentsSummary(rounds) },
    };
  }),
});
