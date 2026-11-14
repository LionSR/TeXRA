/**
 * The documents a revision's reply holds, written as the revision's output
 * files. The reply should wrap them in
 * `<documents><document name="...">`; when it does not, the recovery tiers
 * below run in order, each allowed only the names the launch expects
 * ({@link ExpectedDocuments}). Each tier is LaTeX text recovery; the file
 * reads and writes around them are this module's.
 */
import * as path from 'node:path';
import { RunFileService } from '@texra-ai/harness/plugins';
import { entryTypeIn } from '@texra-ai/harness/node';

import { Effect, FileSystem } from 'effect';

import { createExternalLocation } from '@texra-ai/harness/host';
import {
  toErrorMessage,
  fileLocationDisplayPath,
  type FileLocation,
  formatResultCount,
} from '@texra-ai/harness/schemas';

import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import { getExtractedDocOutputFileName } from '@texra/utils/files/outputFileUtils';
import {
  DOCUMENT_NAME_REGEX,
  bareLatexDocument,
  extractDocuments,
  type NamedDocument,
} from '@texra/utils/text/xmlExtraction';
import {
  OUTPUT_DOCUMENT_TAG,
  OUTPUT_DOCUMENTS_TAG,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';
import { addCdataToTagsMultiple } from '@texra/utils/text/xmlCdata';
import { recoverLogged } from '@texra/utils/diagnostics/recoverLogged';

import {
  assignByContentSimilarity,
  collectLatexFencedBlocks,
  stripScratchpad,
} from './extraction/contentSimilarity';
import {
  extractFilenameHeaderDocuments,
  normalizeDocumentName,
  type ExpectedDocuments,
} from './extraction/filenameHeaders';
import type { AgentTrace } from '@texra-ai/harness/plugins';
import type { ConfigProvider } from '@texra-ai/harness/host';

/** What the extraction reads of the run. */
interface ReplyContext {
  readonly expected: ExpectedDocuments;
  readonly run: {
    readonly logger: AgentTrace;
    readonly fileService: RunFileService;
  };
}

/** Delete any pre-staged symlink before writing so the write never follows the link into the immutable snapshot. */
const writeRoundOutput = Effect.fn('replyDocuments.writeRoundOutput')(
  function* (absolutePath: string, content: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
    // `FileSystem.stat` follows a link, so the probe is the link-aware one:
    // a link must be seen as itself to be removed rather than written through.
    const type = yield* entryTypeIn(fs, absolutePath);
    if (type === 'SymbolicLink') {
      yield* fs.remove(absolutePath, { force: true });
    }
    yield* fs.writeFileString(absolutePath, content);
  },
);

/** Global version of DOCUMENT_NAME_REGEX for counting matches */
const DOCUMENT_NAME_REGEX_GLOBAL = new RegExp(DOCUMENT_NAME_REGEX.source, 'g');

function documentsByTags(
  logger: AgentTrace,
  outputContent: string,
  preferredName?: string,
): NamedDocument[] | null {
  const tagged = extractDocuments(outputContent, OUTPUT_DOCUMENTS_TAG);
  if (tagged) {
    logger.debug(
      `Recovered ${OUTPUT_DOCUMENTS_TAG} from document tags (${formatResultCount(tagged.length, 'document')})`,
    );
    return tagged;
  }
  // A bare `\documentclass` block is one document, and only a reply
  // expected to hold one has a name to give it.
  const bare = preferredName
    ? bareLatexDocument(outputContent, preferredName)
    : undefined;
  if (bare) {
    logger.debug(
      `Recovered ${OUTPUT_DOCUMENTS_TAG} from \\documentclass block (1 document)`,
    );
    return [bare];
  }
  logger.debug(`No ${OUTPUT_DOCUMENTS_TAG} found in output file`);
  return null;
}

const latexFences = (logger: AgentTrace, outputContent: string): string[] =>
  collectLatexFencedBlocks(outputContent, {
    onUnclosedFence: (lineCount) => {
      logger.debug(
        `Dropped unclosed LaTeX fence with ${formatResultCount(lineCount, 'line')} during fallback extraction`,
      );
    },
  });

/**
 * Last-resort recovery for a task that rewrites several inputs and got
 * fenced ```latex/```tex blocks with no filename header at all (neither the
 * `%`-comment nor bare-label forms `extractFilenameHeaderDocuments`
 * recognizes). Matches each fenced block against the inputs' content
 * (`baseFiles`, one per expected name) rather than guessing from response
 * order, since a model can reorder or drop files in its response. The inputs
 * no block matched are `unmatched`.
 */
const documentsBySimilarity = Effect.fn('replyDocuments.bySimilarity')(
  function* (
    { expected, run: { logger } }: ReplyContext,
    outputContent: string,
    baseFiles: readonly FileLocation[],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const blocks = latexFences(logger, outputContent);
    if (blocks.length === 0) return null;

    const files = yield* Effect.forEach(
      baseFiles.slice(0, expected.names.length),
      (loc, idx) =>
        fs.readFileString(loc.absolutePath).pipe(
          Effect.map((text: string) => text.replaceAll('\r\n', '\n')),
          // An unreadable base file becomes '': it will score near-zero
          // similarity against any real fenced block rather than aborting
          // the whole recovery pass. The cause is named, so an empty
          // score is never mistaken for an empty file.
          recoverLogged(
            (error) =>
              logger.warn(
                `Base file ${loc.absolutePath} unreadable during similarity recovery: ${toErrorMessage(error)}`,
              ),
            () => Effect.succeed(''),
          ),
          Effect.map((content) => ({ name: expected.names[idx], content })),
        ),
      { concurrency: 'unbounded' },
    );
    if (files.length === 0) return null;

    const documents = assignByContentSimilarity(blocks, files).filter(
      (d): d is NamedDocument => d !== null,
    );
    if (documents.length === 0) return null;

    logger.debug(
      `Recovered ${OUTPUT_DOCUMENTS_TAG} by matching unlabeled fenced ` +
        `blocks against the original input files (${formatResultCount(documents.length, 'document')})`,
    );
    const matchedNames = new Set(documents.map((doc) => doc.name));
    if (documents.length < blocks.length) {
      logger.debug(
        `${blocks.length - documents.length} of ${formatResultCount(blocks.length, 'fenced block')} matched no input file and were dropped`,
      );
    }
    return {
      documents,
      unmatched: files
        .map((file) => file.name)
        .filter((name) => !matchedNames.has(name)),
    };
  },
);

/**
 * The documents of the reply kept at `outputLocation`, written under its
 * revision's folder, and what the reply should have held and did not: the
 * expected files no document named, the inputs no unlabeled block matched,
 * and each document tag that did not extract.
 */
export const extractReplyDocuments = Effect.fn('replyDocuments.extract')(
  function* (
    ctx: ReplyContext,
    outputLocation: FileLocation,
    round: number,
    /** The inputs' content the similarity tier matches unlabeled blocks
     *  against, one per expected name. */
    baseFiles: readonly FileLocation[],
  ): Effect.fn.Return<
    { outputs: OutputFileInfo[]; missing: string[] },
    Error,
    FileSystem.FileSystem
  > {
    const { expected } = ctx;
    const { logger } = ctx.run;
    const fs = yield* FileSystem.FileSystem;
    const rawOutputContent = (yield* fs.readFileString(
      outputLocation.absolutePath,
    )).replaceAll('\r\n', '\n');
    const missing: string[] = [];
    // The scratchpad is reasoning, not output: a tag it mentions must be
    // neither counted nor extracted as a document.
    const response = stripScratchpad(rawOutputContent);
    // Count document tag occurrences with name attributes (case-sensitive to
    // match extraction).
    const expectedDocumentCount =
      response.match(DOCUMENT_NAME_REGEX_GLOBAL)?.length ?? 0;

    // The document-tag tiers read the CDATA-wrapped variant (which closes
    // an unclosed <document>); the header and similarity tiers below read
    // the raw response instead.
    const cdataWrapped = addCdataToTagsMultiple(
      response,
      [OUTPUT_DOCUMENT_TAG],
      { tag: OUTPUT_DOCUMENT_TAG, container: OUTPUT_DOCUMENTS_TAG },
    );

    let documents = documentsByTags(logger, cdataWrapped);

    if (!documents) {
      documents = extractFilenameHeaderDocuments(rawOutputContent, {
        roundDir: path.dirname(fileLocationDisplayPath(outputLocation)),
        expected,
      });
      if (documents) {
        logger.debug(
          `Recovered ${OUTPUT_DOCUMENTS_TAG} from filename headers (${formatResultCount(documents.length, 'document')})`,
        );
        if (expected.names.length > 1) {
          const recovered = new Set(
            documents.map((doc) => normalizeDocumentName(doc.name)),
          );
          missing.push(
            ...expected.names.filter(
              (name) => !recovered.has(normalizeDocumentName(name)),
            ),
          );
        }
      }
    }

    const { sole } = expected;
    if (!documents && sole) {
      // This fully unlabeled tier is intentionally stricter than
      // filename-header recovery: without a trusted file label, only fences
      // explicitly marked latex/tex are treated as output. It handles the
      // single-block case too because it strips the thinking tag first — a
      // scratchpad that drafts inside a ```latex fence would otherwise be
      // written to the user's file as if it were the answer.
      const fencedBlocks = latexFences(logger, rawOutputContent);
      // A task that writes one new document from many inputs (ocr,
      // paper2slide) gets one fence per input, so all of them belong to the
      // output. A task rewriting its one input gets the revised document
      // first, and any later fence is explanatory prose.
      const blocks = expected.rewritesInputs
        ? fencedBlocks.slice(0, 1)
        : fencedBlocks;
      if (blocks.length > 0) {
        documents = [{ name: sole, content: blocks.join('\n\n') }];
        logger.debug(
          `Recovered ${OUTPUT_DOCUMENTS_TAG} from ` +
            `unlabeled fenced blocks under ${sole} (${formatResultCount(blocks.length, 'block')})`,
        );
      }
    }

    if (!documents && sole) {
      // A model expected to write exactly one file that regressed to a bare
      // \documentclass block can still be recovered under that name. With
      // several expected files there is no name to route the content to.
      // The name keeps its relative path — getExtractedDocOutputFileName
      // preserves subdirectories so `Draft/Draft1.tex` lands at the right
      // workspace location instead of collapsing to the round root.
      documents = documentsByTags(logger, cdataWrapped, sole);
    }

    if (!documents && expected.rewritesInputs && expected.names.length > 1) {
      const matched = yield* documentsBySimilarity(
        ctx,
        rawOutputContent,
        baseFiles,
      );
      // Recovery is best-effort per block: what stayed unmatched is
      // missing, so a partial recovery never reads as a complete one.
      if (matched) missing.push(...matched.unmatched);
      documents = matched?.documents ?? null;
    }

    // Each document tag the reply held that did not extract.
    const extractedCount = documents?.length ?? 0;
    for (let i = extractedCount; i < expectedDocumentCount; i += 1)
      missing.push(`<unextracted document ${i - extractedCount + 1}>`);
    if (!documents) return { outputs: [], missing };
    return {
      outputs: yield* writeDocuments(ctx, documents, outputLocation, round),
      missing,
    };
  },
);

const writeDocuments = Effect.fn('replyDocuments.write')(function* (
  { run: { logger, fileService } }: ReplyContext,
  latexDocuments: NamedDocument[],
  outputLocation: FileLocation,
  round: number,
): Effect.fn.Return<OutputFileInfo[], Error, FileSystem.FileSystem> {
  const outputFiles: OutputFileInfo[] = [];
  // For workspace/runStorage outputs use the workspace-relative round dir
  // so fileService.createLocation can route through its storage layer.
  // For external outputs, work in absolute paths directly — an absolute
  // path passed through createLocation would be re-classified as external
  // anyway, so skip the round-trip and build the location explicitly.
  const isExternal = outputLocation.kind === 'external';
  const roundDir = path.dirname(fileLocationDisplayPath(outputLocation));

  for (const doc of latexDocuments) {
    if (!doc.name || doc.name === 'unknown' || !doc.content) {
      logger.debug(`Skipping document with empty name or content`);
      continue;
    }

    const source = doc.name.trim();
    if (!source) {
      logger.debug(`Skipping document with empty source name after trimming`);
      continue;
    }

    const texFile = getExtractedDocOutputFileName(source, roundDir);
    const texLocation = isExternal
      ? createExternalLocation(texFile)
      : fileService.createLocation(texFile);
    const cleanedContent = cleanExtractedDocumentContent(
      logger,
      doc.content.trim(),
      texFile,
    );
    yield* writeRoundOutput(texLocation.absolutePath, cleanedContent);
    outputFiles.push({
      source,
      round,
      location: texLocation,
      lineage: null,
      diff: null,
    });
    logger.debug('XML source written to TeX file', {
      data: { source, texFile },
    });
  }

  return outputFiles;
});

/** Apply the session's XML-content replacements to the reply kept at
 *  `fileLocation`, and close a `<documents>` container it left open. */
export const ensureCorrectXmlStructure = Effect.fn(
  'replyDocuments.ensureCorrectXmlStructure',
)(function* (
  fileLocation: FileLocation,
  /** The run's session configuration: the replacement rules it applies. */
  config: ConfigProvider,
  logger: AgentTrace,
): Effect.fn.Return<void, Error, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  logger.debug(`Ensuring correct XML structure: ${fileLocation.absolutePath}`);
  const originalContent = (yield* fs.readFileString(
    fileLocation.absolutePath,
  )).replaceAll('\r\n', '\n');
  const replaced = replacementEngine.applyToXmlContent(originalContent, config);
  yield* logReplacementDiagnostics(replaced.diagnostics);
  let content = replaced.text;

  const closeTag = `</${OUTPUT_DOCUMENTS_TAG}>`;
  const openTag = `<${OUTPUT_DOCUMENTS_TAG}>`;

  if (content.includes(openTag) && !content.endsWith(closeTag)) {
    content =
      content.replace(new RegExp(`${closeTag}.*$`, 's'), '') + `\n${closeTag}`;
  }

  if (content !== originalContent) {
    yield* fs.writeFileString(fileLocation.absolutePath, content);
  }
});

function cleanExtractedDocumentContent(
  logger: AgentTrace,
  content: string,
  fileName: string,
): string {
  const trimmed = content.trimEnd();

  // Strip a trailing \end{document} only from a fragment; a complete
  // document (one with \begin{document}) keeps its closing tag.
  let cleaned = trimmed;
  if (
    !trimmed.includes('\\begin{document}') &&
    trimmed.endsWith('\\end{document}')
  ) {
    cleaned = trimmed.replace(/\\end{document}\s*$/, '').trimEnd();
    logger.debug(`Removed trailing \\end{document} from ${fileName}`);
  }

  return cleaned === '' ? '' : `${cleaned}\n`;
}
