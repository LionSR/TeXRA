/**
 * The documents plugin's state of one document task run, rebuilt from the
 * run's rows on every call: the task (its agent's `task:` block, read from
 * the catalog), its launch inputs, and the revisions
 * its latest `documents/output` row records. Each document tool
 * (`./documentTools`) opens it, does its one step over one revision, and
 * commits the documents again through the one publisher. Nothing is held
 * between calls, except the task's file variables, read once per opening,
 * so a resumed recipe sees what the rows say.
 *
 * A revision is one call of the task's persona. Its prompt is the whole
 * conversation so far as one message: the task's prefix (the documents),
 * then each earlier request with the persona's reply to it, then this
 * revision's request with the compile failures that rejected the last one.
 */
import { dirname } from 'node:path';

import { Cause, Effect, Exit, FileSystem, SynchronizedRef } from 'effect';

import { ChildRuns, type ToolRun } from '@texra-ai/harness/plugins';
import { getCatalogAgent, type AgentEntry } from '@agent/index';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import { getTeXCountStats } from '@latex/texcount';
import {
  qualifyAggregateId,
  fileLocationDisplayPath,
  ToolError,
  type FileLocation,
  type ToolFact,
} from '@shared/schemas';
import {
  WORKFLOW_OUTPUT_BASENAME,
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
  workflowOutputRoundDir,
} from '@texra/shared/constants/workflowOutput';
import {
  documentsOutputFact,
  latestDocumentRounds,
} from '@texra/shared/plugins/documents';
import type { DocumentDiffs } from '@texra/shared/plugins/documentOutputs';
import { XmlOutputManager } from '@texra/agent/output/XmlOutputManager';
import { documentTaskKey } from '@texra/agent/output/documentRecipe';
import {
  createOutputState,
  getOutputFilesByRound,
  roundsFromPersisted,
  roundsToPersisted,
  type OutputDependencies,
  type OutputState,
} from '@texra/agent/output/outputState';
import { LatexDiffManager } from '@texra/agent/output/LatexDiffManager';
import {
  appendCompileFailureRoundContext,
  failureContextFromLogs,
} from '@texra/agent/output/compileFailureRoundContext';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import {
  documentTaskOptions,
  type DocumentTask,
} from '@texra/shared/plugins/documents';
import {
  documentTaskOf,
  taskFileVars,
} from '@texra/tools/documents/documentTask';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { renderPrompt } from '@utils/prompt';
import type { CallRequests, ToolEnv } from '@texra-ai/harness';
import type { AgentConfig } from '@texra-ai/harness/schemas';

/** What the documents read of the run their tool call serves. */
type DocumentRun = Pick<
  ToolRun,
  | 'config'
  | 'logger'
  | 'parentStage'
  | 'fileService'
  | 'runId'
  | 'opening'
  | 'model'
>;

/** The tool call the documents are opened for: its run, its roots, and
 *  where it shows the person a file or notice. */
interface DocumentCall {
  readonly run: DocumentRun;
  readonly env: Pick<ToolEnv, 'roots'>;
  readonly requests: Pick<CallRequests, 'present'>;
}

/** One document task run's documents, opened for one tool call. */
export interface Documents {
  readonly run: DocumentRun;
  /** Where the call shows the person what the step wrote. */
  readonly requests: DocumentCall['requests'];
  readonly task: DocumentTask;
  /** The catalog entry whose `task:` block it is: its file's directory holds
   *  the task's `files`. */
  readonly entry: AgentEntry;
  readonly deps: OutputDependencies;
  readonly state: OutputState;
  readonly xml: XmlOutputManager;
  readonly diff: LatexDiffManager;
  /** Where each base file's pre-run content lives: every revision diffs
   *  against these, never the live file an in-place revision overwrote. */
  readonly baseFiles: FileLocation[];
  /** The revisions as the run's documents: the fact the call's result
   *  states (`ToolResult.facts`), built from the state as the call left it. */
  readonly fact: (diffs?: DocumentDiffs) => ToolFact;
}

/** The files a revision works on: the inputs, then the last outputs. */
function revisionFiles(docs: Documents, revision: number): FileLocation[] {
  const { config, fileService } = docs.deps;
  if (revision === 0)
    return config.inputFiles.map((file) => fileService.createLocation(file));
  const previous = docs.state.rounds.get(revision - 1);
  if (previous?.outputs.length)
    return previous.outputs.map((output) => output.location);
  return config.outputFiles.map((file) => fileService.createLocation(file));
}

/** Where a revision's reply is kept, whole, beside its outputs. */
const replyLocation = (docs: Documents, revision: number) =>
  docs.deps.fileService.createLocation(
    workflowOutputPath({ ext: WORKFLOW_RAW_OUTPUT_EXT, round: revision }),
  );

/** The rejection setting: a failed compile fails the task. */
export const rejectsOnCompileFailure = (
  docs: Documents,
): ReturnType<typeof readSettingFrom<boolean>> =>
  readSettingFrom<boolean>(
    docs.deps.roots,
    DocumentsStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
  );

/**
 * Open the documents of `run`, the document task the calling tool serves.
 * Fails for a run that is no document task's.
 */
export const openDocuments = Effect.fn('documents.open')(function* ({
  run,
  env: { roots },
  requests,
}: DocumentCall) {
  const { config, logger, fileService, runId } = run;
  // The block as the catalog holds it now: the run's exact entry, which its
  // launch stamped.
  const entry = getCatalogAgent(documentTaskKey(config));
  const task = entry && documentTaskOf(entry);
  if (!entry || !task)
    return yield* Effect.fail(
      new ToolError(
        `Run ${runId} is not a document task: its agent '${config.agent}' has no task.`,
      ),
    );
  const rows = yield* (yield* ChildRuns).rows(runId, ['plugin.fact']);
  const state = createOutputState(
    roundsFromPersisted(
      latestDocumentRounds(rows, qualifyAggregateId('run', runId)) ?? [],
    ),
  );
  const sources: FileLocation[] = (
    config.outputFiles.length > 0 ? config.outputFiles : config.inputFiles
  ).map((file) => fileService.locateSource(file));
  const deps: OutputDependencies = {
    config,
    baseFiles: sources,
    logger,
    fileService,
    roots,
  };
  // Snapshots the base files once per run (an earlier call's or attempt's
  // stand); a failure costs only the in-place diffs, and says so.
  const baseFiles = yield* fileService
    .prepareRunWorkspace(sources, {
      linkFiles: supportFiles(roots.workspace, config),
    })
    .pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn(
            `Failed to prepare run workspace; in-place diffs may be empty: ${toErrorMessage(error)}`,
            { data: error },
          );
          return sources;
        }),
      ),
    );
  return {
    run,
    requests,
    task,
    entry,
    deps,
    state,
    xml: new XmlOutputManager(config, logger, fileService, state, roots.config),
    diff: new LatexDiffManager(
      task.rewrite,
      () => getOutputFilesByRound(state),
      logger,
      runId,
      fileService,
      roots,
    ),
    baseFiles,
    fact: (diffs?: DocumentDiffs) =>
      documentsOutputFact(roundsToPersisted(state), diffs),
  } satisfies Documents;
});

/**
 * The prompt of `revision`, and the media it attaches: the conversation so
 * far as one message (see the module note), and the figures and media of
 * the files it works on when the model reads images.
 */
export const revisionPrompt = Effect.fn('documents.revisionPrompt')(function* (
  docs: Documents,
  revision: number,
) {
  const { task, run, deps } = docs;
  const { inputs, entries } = yield* taskInputs(docs);
  const fs = yield* FileSystem.FileSystem;
  const parts: string[] = [];
  const files = revisionFiles(docs, revision);
  if (documentTaskOptions(run.config).attachTeXCount && files.length > 0) {
    const counted = yield* texCount(docs, files);
    if (counted) parts.push(counted);
  }
  const prefix = (yield* renderPrompt(task.prefix, inputs)).trim();
  if (prefix) parts.push(prefix);
  for (let earlier = 0; earlier < revision; earlier++) {
    const request = (yield* renderPrompt(
      task.requests[earlier] ?? '',
      inputs,
    )).trim();
    const reply = yield* fs.readFileString(
      replyLocation(docs, earlier).absolutePath,
    );
    parts.push(
      request,
      `<your_reply revision="${earlier + 1}">\n${reply.trim()}\n</your_reply>`,
    );
  }
  // The compile failures that rejected the last revision, from the logs its
  // check wrote, while the setting rejects on them.
  const failures = docs.state.rounds.get(revision - 1)?.compileFailures ?? [];
  const feedback =
    failures.length > 0 && (yield* rejectsOnCompileFailure(docs))
      ? yield* failureContextFromLogs(failures, deps.logger)
      : undefined;
  const request = (yield* renderPrompt(
    task.requests[revision] ?? '',
    inputs,
  )).trim();
  parts.push(appendCompileFailureRoundContext(request, feedback).trim());
  return {
    prompt: parts.filter(Boolean).join('\n\n'),
    media: yield* revisionMedia(docs, revision, files),
    /** The task's template files the prompt read, for their card. */
    loaded: entries,
  };
});

/** The task's `files` variables as each run opening first read them. */
const taskFileSnapshots = new WeakMap<
  NonNullable<ToolRun['opening']>,
  Effect.Success<ReturnType<typeof taskFileVars>>
>();

/**
 * What a task's templates render from: the run's opening, with the task's
 * `files` variables beside it, and the card entries of the files those
 * variables read. The files are read once per opening (one per launch or
 * resume, held in memory, as the opening itself is), so editing a template
 * file mid-run leaves the run's later revisions as they began.
 */
export const taskInputs = Effect.fn('documents.taskInputs')(function* (
  docs: Documents,
) {
  const { opening } = docs.run;
  const snapshot = opening ? taskFileSnapshots.get(opening) : undefined;
  const read = snapshot ?? (yield* taskFileVars(docs.task, docs.entry.path));
  if (opening && snapshot === undefined) taskFileSnapshots.set(opening, read);
  return {
    inputs: { ...opening?.inputs, ...read.vars },
    entries: read.entries,
  };
});

/** The word counts of `files`; none when TeXCount fails, which costs the
 *  counts, not the revision. */
const texCount = Effect.fn('documents.texCount')(function* (
  docs: Documents,
  files: readonly FileLocation[],
) {
  const { deps } = docs;
  const counted = yield* Effect.exit(
    getTeXCountStats(
      deps.roots.workspace,
      deps.roots,
      files.map((file) => file.absolutePath),
    ),
  );
  if (Exit.isSuccess(counted)) return counted.value;
  if (Cause.hasInterrupts(counted.cause)) return yield* Effect.interrupt;
  deps.logger.debug('TeXCount skipped', { data: Cause.squash(counted.cause) });
  return undefined;
});

/**
 * The media a revision attaches, as paths: the configured media and the
 * figures of the files it works on. None for a model that does not read
 * images; a failed extraction costs the figures, not the revision, and says
 * so.
 */
const revisionMedia = Effect.fn('documents.revisionMedia')(function* (
  docs: Documents,
  revision: number,
  files: readonly FileLocation[],
) {
  const { run, deps } = docs;
  const bound = yield* SynchronizedRef.get(run.model);
  // The launch's media, as absolute paths: the revision's agent run reads
  // them from wherever the launch named them.
  const configured = run.config.mediaFiles.map(
    (file) => deps.fileService.createLocation(file).absolutePath,
  );
  if (!bound.config.capabilities.supportsVision) return configured;
  const media = new LatexMediaManager(
    deps.logger,
    deps.roots,
    deps.fileService,
  );
  // Each revision is a fresh conversation: it gets the figures of the files
  // it works on (the last outputs, mirrored so their references resolve).
  const extracted = yield* Effect.exit(
    Effect.gen(function* () {
      if (revision > 0)
        yield* deps.fileService.ensureMirroredInRunSubdir(
          workflowOutputRoundDir(revision),
          { protectedStem: WORKFLOW_OUTPUT_BASENAME },
        );
      return yield* media.processInputFiles(
        files,
        documentTaskOptions(run.config),
        run.config.mediaFiles.map((file) =>
          deps.fileService.createLocation(file),
        ),
      );
    }),
  );
  if (Exit.isFailure(extracted)) {
    if (Cause.hasInterrupts(extracted.cause)) return yield* Effect.interrupt;
    deps.logger.warn('Figure extraction failed; the revision goes without it', {
      data: Cause.squash(extracted.cause),
    });
    return configured;
  }
  const found = extracted.value.map((file) => file.absolutePath);
  return [...new Set([...configured, ...found])];
});

/** Keep `reply` whole as the revision's reply, which every later
 *  revision's prompt quotes and extraction reads. */
export const keepReply = Effect.fn('documents.keepReply')(function* (
  docs: Documents,
  revision: number,
  reply: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const location = replyLocation(docs, revision);
  yield* fs.makeDirectory(dirname(location.absolutePath), { recursive: true });
  yield* fs.writeFileString(location.absolutePath, reply);
  return location;
});

/** The workspace files a run mirrors into its storage, so the documents'
 *  relative `\input` and figure references resolve there. */
function supportFiles(
  workspaceRoot: string | undefined,
  config: Pick<AgentConfig, 'contextFiles' | 'mediaFiles' | 'inputFiles'>,
): FileLocation[] {
  const extras = new Map<string, FileLocation>();
  for (const value of [
    ...config.contextFiles,
    ...config.mediaFiles,
    ...config.inputFiles,
  ]) {
    if (!value) continue;
    const location = pathToLocationIn(workspaceRoot, value);
    extras.set(fileLocationDisplayPath(location), location);
  }
  return [...extras.values()];
}
