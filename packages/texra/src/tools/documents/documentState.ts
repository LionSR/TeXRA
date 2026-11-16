/**
 * The theory plugin's state of one document task run, rebuilt from the
 * run's rows on every call: the task as its program described it to its
 * first step (`DocumentTaskSpec`), its launch inputs, and the revisions its
 * latest `theory/output` row records. Each document tool
 * (`./documentTools`) opens it, does its one step over one revision, and
 * commits the revisions with that one's next record. Nothing is held
 * between calls, so a resumed program sees what the rows say.
 *
 * A revision is one call of a child agent. Its prompt is the whole
 * conversation so far as one message: the documents, then each earlier
 * request with the child's reply to it, then this revision's request with
 * the compile failures that rejected the last one.
 */
import { basename, dirname, join } from 'node:path';

import { Cause, Effect, Exit, FileSystem, ScopedRef } from 'effect';

import {
  ChildRuns,
  type ToolRun,
  ToolError,
  sourceLocationUnder,
} from '@texra-ai/harness/plugins';
import {
  toErrorMessage,
  fileLocationDisplayPath,
  type FileListEntry,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import { AgentDirectories, pathToLocationIn } from '@texra-ai/harness/host';
import { processInputFiles, type InputMediaOptions } from '@latex/latexMedia';
import { getTeXCountStats } from '@latex/texcount';
import {
  DOCUMENT_OUTPUT_BASENAME,
  revisionLayout,
} from '@texra/shared/constants/revisionLayout';
import {
  DOCUMENTS_OUTPUT_KIND,
  type DocumentTaskSpec,
} from '@texra/shared/plugins/documents';
import {
  OUTPUT_DOCUMENT_TAG,
  OUTPUT_DOCUMENTS_TAG,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import type { OutputDependencies } from '@texra/agent/output/outputFileExtraction';
import { expectedDocuments } from '@texra/agent/output/extraction/filenameHeaders';
import {
  appendCompileFailureRoundContext,
  failureContextFromLogs,
} from '@texra/agent/output/compileFailureRoundContext';
import { runWorkspaceOf } from '@texra/tools/documents/runWorkspace';
import type { CallRequests, ToolEnv } from '@texra-ai/harness/plugins';
import type { AgentConfig } from '@texra-ai/harness/schemas';

/** What the documents read of the run their tool call serves. */
type DocumentRun = Pick<
  ToolRun,
  'config' | 'logger' | 'scope' | 'runId' | 'opening' | 'model'
>;

/** The tool call the documents are opened for: its roots and run, and
 *  where it shows the person a file or notice. */
interface DocumentCall {
  readonly env: Pick<ToolEnv, 'roots'> & { readonly run: DocumentRun };
  readonly requests: Pick<CallRequests, 'present'>;
}

/** One document task run's documents, opened for one tool call. */
export interface Documents {
  readonly run: DocumentRun;
  /** Where the call shows the person what the step wrote. */
  readonly requests: DocumentCall['requests'];
  /** The task as its program described it to its first step. */
  readonly task: DocumentTaskSpec;
  readonly deps: OutputDependencies;
  /** The revisions so far, by `round`, as the run's latest documents fact
   *  records them. A step commits the next list
   *  (`documentsOutputFact(withRound(...))`) in its result's facts; a call
   *  running beside it would commit a list without the other's revision, so
   *  one run's document tools run one at a time (the program's order). */
  readonly rounds: readonly RoundOutput[];
  /** Where each base file's pre-run content lives: every revision diffs
   *  against these, never the live file an in-place revision overwrote. */
  readonly baseFiles: FileLocation[];
}

/** The record of `revision` among `rounds`, if it has one. */
export const roundOf = (
  rounds: readonly RoundOutput[],
  revision: number,
): RoundOutput | undefined => rounds.find((round) => round.round === revision);

/** `rounds` with `next` in its revision's place, in revision order. */
export const withRound = (
  rounds: readonly RoundOutput[],
  next: RoundOutput,
): RoundOutput[] =>
  [...rounds.filter((round) => round.round !== next.round), next].toSorted(
    (a, b) => a.round - b.round,
  );

/** The files a revision works on: the inputs, then the last outputs. */
function revisionFiles(docs: Documents, revision: number): FileLocation[] {
  const { config, fileService } = docs.deps;
  if (revision === 0)
    return config.inputFiles.map((file) => fileService.createLocation(file));
  const previous = roundOf(docs.rounds, revision - 1);
  if (previous?.outputs.length)
    return previous.outputs.map((output) => output.location);
  return config.outputFiles.map((file) => fileService.createLocation(file));
}

/** Where a revision's reply is kept, whole, beside its outputs, in the
 *  run's storage, whose per-run directory keeps the fixed name from
 *  colliding across runs. */
const replyLocation = (docs: Documents, revision: number) =>
  docs.deps.fileService.createLocation(revisionLayout(revision).reply);

/**
 * Open the documents of `run`, the document task the calling tool serves.
 * `described` is the task as the call itself describes it (the program's
 * `document_context` calls); any other step reads what the run's first
 * step recorded, and fails for a run that recorded none.
 */
export const openDocuments = Effect.fn('documents.open')(function* (
  { env: { roots, run }, requests }: DocumentCall,
  described?: DocumentTaskSpec,
) {
  const { config, logger, runId } = run;
  const fileService = runWorkspaceOf(run, roots);
  const output = yield* (yield* ChildRuns).fact(runId, DOCUMENTS_OUTPUT_KIND);
  const task = output?.task ?? described;
  if (task === undefined)
    return yield* Effect.fail(
      new ToolError(
        `Run ${runId} has no documents yet: a document program's first step is \`document_context\` for revision 0.`,
      ),
    );
  const expected = expectedDocuments(config);
  const sources = expected.names.map((file) =>
    sourceLocationUnder(roots, file),
  );
  const deps: OutputDependencies = {
    config,
    expected,
    sources,
    logger,
    fileService,
    roots,
  };
  // Snapshots the base files once per run (an earlier call's or attempt's
  // stand). The snapshots are the run's restore point and the diff base an
  // in-place rewrite is compared against, so a failed capture stops the task
  // rather than letting it rewrite files it could not restore. The harness
  // already keeps an absent file and a failed dependency mirror out of it.
  const baseFiles = yield* fileService
    .prepareRunWorkspace(sources, {
      linkFiles: supportFiles(roots.workspace, config),
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new ToolError(
            `Run ${runId} could not snapshot the documents it starts from: ${toErrorMessage(error)}`,
            { cause: error },
          ),
      ),
    );
  return {
    run,
    requests,
    task,
    deps,
    rounds: output?.rounds ?? [],
    baseFiles,
  } satisfies Documents;
});

/** What a `document_context` call asks of one revision's prompt, beside
 *  the task itself. */
export interface RevisionRequest extends InputMediaOptions {
  /** Whether the prompt carries the documents' TeXCount statistics. */
  readonly attachTeXCount: boolean;
}

/** Where the plugin's template files ship, under the host's packaged
 *  resources; undefined for a host that ships none. */
export const templateDirectory = Effect.map(
  AgentDirectories,
  ({ resourcesRoot }) =>
    resourcesRoot === undefined
      ? undefined
      : join(resourcesRoot, 'plugins', 'theory', 'templates'),
);

/** The task's template files, read: each is a document of the prompt, under
 *  its file name. A template that does not read fails the step. */
const readTemplates = Effect.fn('documents.readTemplates')(function* (
  task: DocumentTaskSpec,
) {
  if (task.templates.length === 0) return [];
  const directory = yield* templateDirectory;
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(task.templates, (name) =>
    Effect.gen(function* () {
      if (directory === undefined)
        return yield* Effect.fail(
          new ToolError(
            `This host ships no document templates, so '${name}' cannot be read.`,
          ),
        );
      // A template is one of the shipped files, by its name: a path would
      // read outside their directory.
      if (basename(name) !== name || name === '..')
        return yield* Effect.fail(
          new ToolError(
            `'${name}' is not a template's file name: name one of the shipped templates, with no directory.`,
          ),
        );
      const path = join(directory, name);
      const content = yield* fs
        .readFileString(path)
        .pipe(
          Effect.mapError(
            (error) =>
              new ToolError(
                `The template '${name}' could not be read: ${toErrorMessage(error)}`,
                { cause: error },
              ),
          ),
        );
      return { name, path, content };
    }),
  );
});

/**
 * The prompt of `revision`, and the media it attaches: the conversation so
 * far as one message (see the module note), and the figures and media of
 * the files it works on when the model reads images.
 */
export const revisionPrompt = Effect.fn('documents.revisionPrompt')(function* (
  docs: Documents,
  revision: number,
  asked: RevisionRequest,
  critique?: string | null,
) {
  const { task, run, deps } = docs;
  const inputs = run.opening?.inputs ?? {};
  const templates = yield* readTemplates(task);
  const fs = yield* FileSystem.FileSystem;
  const parts: string[] = [];
  const files = revisionFiles(docs, revision);
  if (asked.attachTeXCount && files.length > 0) {
    const counted = yield* texCount(docs, files);
    if (counted) parts.push(counted);
  }
  // The documents: the context, the task's templates, then the inputs.
  const documents = [
    inputs.ALL_CONTEXTS,
    ...templates.map(
      ({ name, content }) =>
        `<document name="${name}">\n${content}\n</document>`,
    ),
    inputs.ALL_INPUTS,
  ].filter(Boolean);
  parts.push(
    task.intro.trim(),
    ...(documents.length > 0
      ? [`<documents>\n${documents.join('\n')}\n</documents>`]
      : []),
    // A partial edit of the input, which a merge puts back into it.
    ...(inputs.EDITED_CONTENT
      ? [
          `The edited version, ${inputs.EDITED_FILE ?? 'as given'}:\n<edited_document>\n${inputs.EDITED_CONTENT}\n</edited_document>`,
        ]
      : []),
    ...(inputs.INSTRUCTION?.trim()
      ? [
          `Follow this instruction closely. Where it names a part of the documents, leave the rest as it is:\n<instruction>\n${inputs.INSTRUCTION.trim()}\n</instruction>`,
        ]
      : []),
  );
  const replies = yield* Effect.forEach(
    Array.from({ length: revision }, (_, earlier) => earlier),
    (earlier) => fs.readFileString(replyLocation(docs, earlier).absolutePath),
    { concurrency: 8 },
  );
  for (const [earlier, reply] of replies.entries())
    parts.push(
      (task.requests[earlier] ?? '').trim(),
      `<your_reply revision="${earlier + 1}">\n${reply.trim()}\n</your_reply>`,
    );
  // The compile failures that rejected the last revision, from the logs its
  // check wrote.
  const compiled = roundOf(docs.rounds, revision - 1)?.compile;
  let feedback: string | undefined;
  if (compiled?._tag === 'checked' && compiled.rejected) {
    const read = yield* failureContextFromLogs(compiled.failures);
    if (read.kind === 'unreadable') deps.logger.warn(read.warning);
    else feedback = read.text;
  }
  const request = (task.requests[revision] ?? '').trim();
  // The reply format the program parses, written here so no task restates
  // it: one document per name the revision writes (its outputs, or the
  // inputs it rewrites), in order.
  const names =
    (deps.expected.rewritesInputs ? inputs.INPUT_FILES : inputs.OUTPUT_FILES) ??
    [];
  const reply = [
    `Output the documents, complete and in this order, as:`,
    `<${OUTPUT_DOCUMENTS_TAG}>`,
    ...names.map(
      (name) =>
        `<${OUTPUT_DOCUMENT_TAG} name="${name}">\n...\n</${OUTPUT_DOCUMENT_TAG}>`,
    ),
    `</${OUTPUT_DOCUMENTS_TAG}>`,
  ].join('\n');
  // What a check or a critic said of the last revision goes with this
  // revision's request; the reply format stays last, where the program's
  // parser needs the model to have read it most recently.
  const review = critique?.trim();
  parts.push(
    appendCompileFailureRoundContext(request, feedback).trim(),
    ...(review
      ? [
          `A reviewer read your last revision. Apply the corrections that hold, and the suggested improvement where it serves this request:\n<critique revision="${revision}">\n${review}\n</critique>`,
        ]
      : []),
    reply,
  );
  return {
    prompt: parts.filter(Boolean).join('\n\n'),
    media: yield* revisionMedia(docs, revision, files, asked),
    /** The template files the prompt read, for their card. */
    loaded: templates.map(({ path }): FileListEntry => ({
      path,
      ok: true,
      source: 'templates',
    })),
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
  options: InputMediaOptions,
) {
  const { run, deps } = docs;
  const bound = yield* ScopedRef.get(run.model);
  // The launch's media, as absolute paths: the revision's agent run reads
  // them from wherever the launch named them.
  const configured = run.config.mediaFiles.map(
    (file) => deps.fileService.createLocation(file).absolutePath,
  );
  if (!bound.config.capabilities.supportsVision) return configured;
  // Each revision is a fresh conversation: it gets the figures of the files
  // it works on (the last outputs, mirrored so their references resolve).
  const extracted = yield* Effect.exit(
    Effect.gen(function* () {
      if (revision > 0)
        yield* deps.fileService.ensureMirroredInRunSubdir(
          revisionLayout(revision).dir,
          { protectedStem: DOCUMENT_OUTPUT_BASENAME },
        );
      return yield* processInputFiles(deps, files, options);
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
