/**
 * Output file extraction orchestration.
 *
 * Drives the agent output pipeline: waits for workspace preparation, then
 * unpacks <documents><document name="..."> containers from the model's XML
 * response.
 *
 * Note: this module is about the *agent output pipeline*, not general XML
 * parsing. Low-level XML text utilities live in @texra/utils/text/xmlExtraction.
 */

import {
  normalizeFilePath,
  fileLocationDisplayPath,
  toErrorMessage,
  type AgentConfig,
  type FileLocation,
} from '@texra-ai/harness/schemas';
import { Effect, FileSystem } from 'effect';

import { revisionLayout } from '@texra/shared/constants/revisionLayout';
import { recoverLogged } from '@texra/utils/diagnostics/recoverLogged';
import {
  OUTPUT_DOCUMENTS_TAG,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';

import { replaceInputCommands } from './fileMapping';
import { extractReplyDocuments } from './replyDocuments';
import type { ExpectedDocuments } from './extraction/filenameHeaders';
import type { AgentTrace, RunFileService } from '@texra-ai/harness/plugins';
import type { WorkspaceRoots } from '@texra-ai/harness';

/** What the output pipeline reads of the document task's run. */
export interface OutputDependencies {
  readonly config: AgentConfig;
  /** The documents the launch expects a reply to name. */
  readonly expected: ExpectedDocuments;
  /** Those documents where the launch named them: what an unlabeled reply
   *  is matched against and its `\input`s are rewritten from. */
  readonly sources: FileLocation[];
  readonly logger: AgentTrace;
  readonly fileService: RunFileService;
  /** The run's session roots, held as data: the pipeline runs on the run's
   *  fiber, and nothing about a fiber names the project it works on. */
  readonly roots: WorkspaceRoots;
}

/** What a revision's reply held: the outputs it wrote, and what it should
 *  have written and did not. */
interface ExtractedRevision {
  readonly outputs: OutputFileInfo[];
  readonly missing: string[];
}

/**
 * Base files for the unlabeled-fence similarity fallback. Rounds after the
 * first revise the previous round's outputs, so compare against those, not
 * the originals the content may have diverged from. Positional order is
 * preserved (the fallback zips base files with the agent's inputFiles by
 * index); a file the previous round did not produce keeps its original
 * location.
 */
function similarityBaseFiles(
  baseFiles: FileLocation[],
  previousOutputs: readonly OutputFileInfo[],
): FileLocation[] {
  if (previousOutputs.length === 0) return baseFiles;

  // An output's source is the workspace-relative document name; a base
  // file is workspace-relative too, except external locations, which only
  // carry an absolute path — hence the suffix comparison. A suffix match
  // only counts when it is unambiguous: a basename-only source (e.g. from
  // a `% main.tex` header) must not map onto several same-named base
  // files in different directories.
  const pathOf = (location: FileLocation): string =>
    normalizeFilePath(fileLocationDisplayPath(location));
  const basesMatching = (source: string): number =>
    baseFiles.filter((base) => {
      const path = pathOf(base);
      return path === source || path.endsWith(`/${source}`);
    }).length;

  return baseFiles.map((location) => {
    const path = pathOf(location);
    const previous = previousOutputs.find((output) => {
      const source = normalizeFilePath(output.source);
      if (source === path) return true;
      return path.endsWith(`/${source}`) && basesMatching(source) === 1;
    });
    return previous?.location ?? location;
  });
}

/**
 * Warn of a round that wrote nothing (its kept reply, which hosts offer to
 * open, is the round's `reply`).
 */
const warnNoOutputs = Effect.fn('documents.warnNoOutputs')(function* (
  deps: OutputDependencies,
  currRound: number,
  outputLocation: FileLocation,
): Effect.fn.Return<void, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  // Distinguish a genuinely empty turn from a non-empty response that simply
  // could not be parsed: if the model returned content but nothing extracted,
  // it almost always means it did not wrap each file in
  // `<document name="…">`. Surface that as a warning so the round is not a
  // silent "success" that writes no files; the raw response is kept for recovery.
  // An unreadable raw response reads as empty here: the round still records
  // no outputs beside its kept `reply`, which hosts show as a round that
  // wrote no documents, so it is never a quiet success.
  const rawText = yield* fs.readFileString(outputLocation.absolutePath).pipe(
    Effect.map((text: string) => text.replaceAll('\r\n', '\n')),
    recoverLogged(
      (error) =>
        deps.logger.warn(
          `The raw response at ${outputLocation.absolutePath} could not be read: ${error.message}`,
        ),
      () => Effect.succeed(''),
    ),
  );
  if (rawText.trim().length > 0) {
    deps.logger.warn(
      `The model returned output but no files could be extracted from it: it likely did not wrap each document in <${OUTPUT_DOCUMENTS_TAG}>. The raw response was kept at ${outputLocation.absolutePath} for recovery.`,
      {
        data: {
          round: currRound,
          rawResponsePath: outputLocation.absolutePath,
        },
      },
    );
  }
});

/**
 * The expected output files the revision lacks, with what extraction found
 * missing. The outputs are the authority on the expected files alone, never
 * the revision folder, which still holds an earlier attempt's files: every
 * other entry (a document the reply held that did not extract) is kept.
 */
function withMissingExpected(
  deps: OutputDependencies,
  currRound: number,
  { outputs, missing }: ExtractedRevision,
): string[] {
  const expected = deps.config.outputFiles;
  // The round writes its outputs into its own directory; the run-root entry
  // of the same name is the workspace file, delivered only later.
  const written = new Set(
    outputs.map((output) => output.location.absolutePath),
  );
  const { dir } = revisionLayout(currRound);
  const lacking = expected.filter(
    (file) =>
      !written.has(
        deps.fileService.createLocation(`${dir}/${file}`).absolutePath,
      ),
  );
  if (expected.length > 0)
    deps.logger.debug(
      lacking.length > 0
        ? `Missing expected outputs for round ${currRound}`
        : `All ${expected.length} expected outputs written in round ${currRound}`,
      { data: lacking },
    );
  return [
    ...new Set(missing.filter((entry) => !expected.includes(entry))),
    ...lacking,
  ];
}

/**
 * The files a revision's reply holds: the unified protocol emits
 * <documents><document name="..."> containers (N >= 1), so every agent
 * unpacks that container into per-document output files. A reply that could
 * not be read or unpacked is a revision that wrote nothing, and says so.
 */
export const extractFilesFromXml = Effect.fn('documents.extractFilesFromXml')(
  function* (
    deps: OutputDependencies,
    outputLocation: FileLocation,
    currRound: number,
    /** The outputs of the revision before it, which this one revises. */
    previousOutputs: readonly OutputFileInfo[],
  ) {
    const { logger } = deps;
    logger.debug(
      `Processing multiple outputs for ${outputLocation.absolutePath}`,
    );
    const nothing: ExtractedRevision = { outputs: [], missing: [] };
    const extracted = yield* Effect.gen(function* () {
      const split = yield* extractReplyDocuments(
        {
          expected: deps.expected,
          run: { logger: deps.logger, fileService: deps.fileService },
        },
        outputLocation,
        currRound,
        similarityBaseFiles(deps.sources, previousOutputs),
      );
      if (split.outputs.length === 0) {
        logger.debug(
          `No processed files were generated from ${outputLocation.absolutePath}`,
        );
        yield* warnNoOutputs(deps, currRound, outputLocation);
        return split;
      }
      if (deps.sources.length > 0) {
        yield* replaceInputCommands(deps.sources, split.outputs, logger);
      }
      return split;
    }).pipe(
      recoverLogged(
        (error) =>
          logger.warn(`Error processing output file: ${toErrorMessage(error)}`),
        () =>
          warnNoOutputs(deps, currRound, outputLocation).pipe(
            Effect.as(nothing),
          ),
      ),
    );
    return {
      outputs: extracted.outputs,
      missing: withMissingExpected(deps, currRound, extracted),
    };
  },
);
