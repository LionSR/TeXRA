/**
 * The documents plugin's state of one document task run, rebuilt from the
 * run's rows on every call: the task, its launch inputs, and the revisions
 * its latest `documents/output` row records. Each document tool
 * (`./documentTools`) opens it, does its one step over one revision, and
 * commits the documents again through the one publisher. Nothing is held
 * between calls, so a resumed recipe sees what the rows say.
 *
 * A revision is one call of the task's persona. Its prompt is the whole
 * conversation so far as one message: the task's prefix (the documents),
 * then each earlier request with the persona's reply to it, then this
 * revision's request with the compile failures that rejected the last one.
 */
import { dirname } from 'node:path';

import { Cause, Effect, Exit, FileSystem, SynchronizedRef } from 'effect';

import { LatexMediaManager } from '@latex/LatexMediaManager';
import { getTeXCountStats } from '@latex/texcount';
import {
  documentsOutputFact,
  latestDocumentRounds,
} from '@shared/plugins/documents';
import {
  WORKFLOW_RAW_OUTPUT_EXT,
  workflowOutputPath,
} from '@shared/constants/workflowOutput';
import {
  aggregateId,
  fileLocationDisplayPath,
  ToolError,
  type FileLocation,
  type ToolFact,
} from '@shared/schemas';
import { XmlOutputManager } from '@texra/agent/output/XmlOutputManager';
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
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { renderPrompt } from '@utils/prompt';
import type { ToolRun } from '@texra-ai/harness/plugins';
import type { DocumentTask, AgentConfig } from '@texra-ai/harness/schemas';

/** What the documents read of the run their tool call serves. */
type DocumentRun = Pick<
  ToolRun,
  | 'task'
  | 'config'
  | 'logger'
  | 'fileService'
  | 'session'
  | 'runId'
  | 'opening'
  | 'model'
>;

/** One document task run's documents, opened for one tool call. */
export interface Documents {
  readonly run: DocumentRun;
  readonly task: DocumentTask;
  readonly deps: OutputDependencies;
  readonly state: OutputState;
  readonly xml: XmlOutputManager;
  readonly diff: LatexDiffManager;
  /** Where each base file's pre-run content lives: every revision diffs
   *  against these, never the live file an in-place revision overwrote. */
  readonly baseFiles: FileLocation[];
  /** The revisions as the run's documents: the fact the call's result
   *  states (`ToolResult.facts`), built from the state as the call left it. */
  readonly fact: () => ToolFact;
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
export const openDocuments = Effect.fn('documents.open')(function* (
  run: DocumentRun,
) {
  const { task, config, logger, fileService, session, runId } = run;
  if (task === null)
    return yield* Effect.fail(
      new ToolError(
        `Run ${runId} is not a document task: its agent '${config.agent}' has no task.`,
      ),
    );
  const { roots } = session;
  const aggregate = aggregateId('run', runId);
  const rows = yield* session.log.rows(aggregate, ['plugin.fact']);
  const state = createOutputState(
    roundsFromPersisted(latestDocumentRounds(rows, aggregate) ?? []),
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
    task,
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
    fact: () => documentsOutputFact(roundsToPersisted(state)),
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
  const inputs = run.opening?.inputs ?? {};
  const fs = yield* FileSystem.FileSystem;
  const parts: string[] = [];
  const files = revisionFiles(docs, revision);
  if (run.config.toolConfig.attachTeXCount && files.length > 0) {
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
  const found: string[] = [];
  const workspace = {
    media: {
      addMediaFiles: (locations: readonly FileLocation[]) => {
        found.push(...locations.map((file) => file.absolutePath));
      },
    },
  };
  // Each revision is a fresh conversation: it gets the figures of the files
  // it works on (the last outputs, mirrored so their references resolve).
  const extracted = yield* Effect.exit(
    Effect.gen(function* () {
      if (revision > 0)
        yield* deps.fileService.ensureMirroredInRoundDir(revision);
      yield* media.processInputFiles(
        files,
        workspace,
        run.config.toolConfig,
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
