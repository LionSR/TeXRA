import * as path from 'node:path';

import { diff_match_patch } from 'diff-match-patch';
import escapeRegExp from 'escape-string-regexp';
import { XMLParser } from 'fast-xml-parser';

import {
  debugInternal,
  logInternal,
  logMissingOutputs,
  type AgentTrace,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentSetting } from '@agent/core/definition/AgentDataclass';
import {
  getExtractedDocOutputFileName,
  getSafeDocumentRelativePath,
} from '@agent/utils/outputFileUtils';
import { toErrorMessage } from '@common/errors';
import replacementEngine, { applyReplacements } from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import type { FileLocation, OutputFileInfo } from '@shared/schemas';
import { getBasename, normalizeFilePath } from '@shared/utils/path';
import {
  AbsoluteFS,
  createExternalLocation,
  getFileDirectory,
  TaskRunFileService,
} from '@utils/files';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  addCdataToTagsMultiple,
  DOCUMENT_NAME_REGEX,
  extractContentFromXMLbyTagMultiple,
  extractDocuments,
} from '@utils/text/xmlUtils';

/** Delete any pre-staged symlink before writing so the write never follows the link into the immutable snapshot. */
async function writeRoundOutput(
  absolutePath: string,
  content: string,
): Promise<void> {
  await AbsoluteFS.ensureDir(path.dirname(absolutePath));
  if (await AbsoluteFS.isSymbolicLink(absolutePath)) {
    await AbsoluteFS.delete(absolutePath);
  }
  await AbsoluteFS.write(absolutePath, content);
}

/** Global version of DOCUMENT_NAME_REGEX for counting matches */
const DOCUMENT_NAME_REGEX_GLOBAL = new RegExp(DOCUMENT_NAME_REGEX.source, 'g');

/** Shared XMLParser configuration for scratchpad output extraction */
const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  parseTagValue: true,
  textNodeName: 'content',
  attributeNamePrefix: '',
  processEntities: false,
  ignoreDeclaration: true,
} as const;

/** Human-readable descriptions for document extraction methods */
const EXTRACTION_METHOD_MESSAGES: Record<string, string> = {
  named: 'from named document tag',
  simple: 'using fallback method',
  latex_document: 'from legacy <latex_document> tag',
  markdown: 'from markdown code block',
  latex: 'from \\documentclass block',
};

const PERCENT_FILENAME_HEADER_REGEX =
  /^%\s+((?:\.[/\\])*[A-Za-z0-9_][A-Za-z0-9._/\\-]*\.[A-Za-z0-9]+)\s*$/;
/** Strip markdown emphasis/label punctuation a model might wrap a bare filename in. */
const BARE_LABEL_DECORATION_REGEX = /^[*_`]+|[*_`:]+$/g;

/**
 * Recognize a header line that names one of the agent's known files directly,
 * without the `%` comment prefix (e.g. `Draft/Draft3.tex:` or
 * `**Draft3.tex**`). Unlike the percent-header form, a bare line like this is
 * never valid LaTeX on its own, so the only ambiguity risk is a coincidental
 * match — guarded against by only ever matching against the agent's own
 * known files rather than any path-shaped string.
 */
function matchKnownFileLabel(
  line: string,
  knownFiles: readonly string[],
): string | null {
  const stripped = line.trim().replaceAll(BARE_LABEL_DECORATION_REGEX, '');
  if (!stripped) return null;
  const candidate = normalizeFilePath(stripped).replace(/^(?:\.\/)+/, '');
  const exact = knownFiles.find((f) => normalizeFilePath(f) === candidate);
  if (exact) return exact;

  // Fall back to a basename match when the model dropped the leading
  // directories, but only when it resolves unambiguously.
  const basenameMatches = knownFiles.filter(
    (f) => getBasename(f) === candidate,
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}
const LATEX_DOCUMENTCLASS_REGEX = /\\documentclass\b/;
const LATEX_DOCUMENT_BEGIN_REGEX = /\\begin\s*\{\s*document\s*\}/;
const LATEX_DOCUMENT_END_REGEX = /\\end\s*\{\s*document\s*\}/;
const LIKELY_LATEX_CONTENT_REGEX =
  /^\\(?:chapter|section|subsection|subsubsection|paragraph|begin|end|input|include|documentclass|usepackage|newcommand|renewcommand|[([])/;

type MarkdownFence = {
  marker: '`' | '~';
  length: number;
};

function parseMarkdownFenceDelimiter(line: string): MarkdownFence | null {
  const match = /^(`{3,}|~{3,})(?:\s*\S.*)?\s*$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const delimiter = match[1];
  return {
    marker: delimiter[0] as '`' | '~',
    length: delimiter.length,
  };
}

function isMarkdownFenceDelimiter(line: string): boolean {
  return parseMarkdownFenceDelimiter(line) !== null;
}

function isClosingMarkdownFence(
  line: string,
  openingFence: MarkdownFence,
): boolean {
  const closingFence = parseMarkdownFenceDelimiter(line);
  return (
    closingFence !== null &&
    closingFence.marker === openingFence.marker &&
    closingFence.length >= openingFence.length
  );
}

function stripSurroundingMarkdownFence(lines: readonly string[]): string[] {
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex === -1) {
    return [];
  }

  const lastContentIndex = lines.findLastIndex((line) => line.trim() !== '');
  if (
    firstContentIndex < lastContentIndex &&
    isMarkdownFenceDelimiter(lines[firstContentIndex]) &&
    isMarkdownFenceDelimiter(lines[lastContentIndex])
  ) {
    return [
      ...lines.slice(0, firstContentIndex),
      ...lines.slice(firstContentIndex + 1, lastContentIndex),
      ...lines.slice(lastContentIndex + 1),
    ];
  }

  return [...lines];
}

function getLatexDocumentContext(lines: readonly string[]): {
  insideDocumentBody: boolean;
  inDocumentPreamble: boolean;
} {
  let depth = 0;
  let sawDocumentclassWithoutBody = false;
  for (const line of lines) {
    if (line.trim().startsWith('%')) {
      continue;
    }
    if (LATEX_DOCUMENTCLASS_REGEX.test(line)) {
      sawDocumentclassWithoutBody = true;
    }
    if (LATEX_DOCUMENT_BEGIN_REGEX.test(line)) {
      depth += 1;
      sawDocumentclassWithoutBody = false;
    }
    if (LATEX_DOCUMENT_END_REGEX.test(line) && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        sawDocumentclassWithoutBody = false;
      }
    }
  }
  return {
    insideDocumentBody: depth > 0,
    inDocumentPreamble: sawDocumentclassWithoutBody,
  };
}

function hasDocumentBeginInCurrentPreamble(
  lines: readonly string[],
  startIndex: number,
): boolean {
  for (const line of lines.slice(startIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%')) {
      continue;
    }
    if (LATEX_DOCUMENTCLASS_REGEX.test(line)) {
      return false;
    }
    if (LATEX_DOCUMENT_BEGIN_REGEX.test(line)) {
      return true;
    }
  }
  return false;
}

function shouldKeepPercentHeaderAsLatexComment(
  linesBeforeHeader: readonly string[],
  allLines: readonly string[],
  headerIndex: number,
): boolean {
  const context = getLatexDocumentContext(linesBeforeHeader);
  if (context.insideDocumentBody) {
    return true;
  }
  return (
    context.inDocumentPreamble &&
    hasDocumentBeginInCurrentPreamble(allLines, headerIndex)
  );
}

function hasLikelyLatexContent(lines: readonly string[]): boolean {
  return lines.some((line) => LIKELY_LATEX_CONTENT_REGEX.test(line.trim()));
}

/** Opening delimiter for a fenced block explicitly tagged as latex/tex. */
const LATEX_FENCE_OPEN_REGEX = /^(`{3,}|~{3,})\s*(?:latex|tex)\s*$/i;

/** Collect the content of every ```latex/```tex fenced block, in document order. */
function collectLatexFencedBlocks(
  content: string,
  thinkingTag: string,
): string[] {
  const lines = stripXmlTagBlocks(content, thinkingTag)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');

  const blocks: string[] = [];
  let openFence: MarkdownFence | null = null;
  let current: string[] = [];

  for (const line of lines) {
    if (!openFence) {
      if (LATEX_FENCE_OPEN_REGEX.test(line.trim())) {
        openFence = parseMarkdownFenceDelimiter(line);
        current = [];
      }
      continue;
    }
    if (isClosingMarkdownFence(line, openFence)) {
      const block = current.join('\n').trim();
      if (block) blocks.push(block);
      openFence = null;
      current = [];
      continue;
    }
    current.push(line);
  }
  return blocks;
}

/**
 * Similarity in [0, 1] between two documents via a `diff-match-patch` Myers
 * diff (with the line-mode speedup enabled, which keeps this cheap for
 * large, mostly-unchanged documents): 1 minus the diff's edit distance,
 * normalized by the longer document's length. Clamped at 0 because
 * `diff_levenshtein` counts a substitution as delete-plus-insert, which can
 * exceed the longer length for very different documents.
 */
function documentSimilarity(
  dmp: InstanceType<typeof diff_match_patch>,
  a: string,
  b: string,
): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length, 1);
  const diffs = dmp.diff_main(a, b, true);
  return Math.max(0, 1 - dmp.diff_levenshtein(diffs) / maxLength);
}

/**
 * Greedily pair each candidate document with the base file it most closely
 * resembles, highest-confidence pairs first, so an unambiguous match never
 * gets displaced by a later tie. Never guesses: candidates below
 * `minSimilarity`, candidates whose best remaining files tie exactly (e.g.
 * identical template stubs), and leftovers once the other side is exhausted
 * all come back unmatched.
 */
function assignByContentSimilarity(
  candidates: readonly string[],
  files: ReadonlyArray<{ name: string; content: string }>,
  minSimilarity = 0.15,
): Array<{ content: string; name: string } | null> {
  const dmp = new diff_match_patch();
  const scores = candidates.map((candidate) =>
    files.map((file) => documentSimilarity(dmp, candidate, file.content)),
  );
  const bestFileOf = scores.map((row) => row.indexOf(Math.max(...row)));

  // A block that echoes a base file verbatim (modulo surrounding whitespace —
  // fenced blocks arrive trimmed) is a quote of the original, not a revision.
  // When some other block's best match is that same file (the model quoted
  // the original before its revision), drop the verbatim pair so the
  // revision can claim the file.
  const trimmedFileContents = files.map((file) => file.content.trim());
  const isDisplacedEcho = (c: number, f: number): boolean =>
    candidates[c].trim() === trimmedFileContents[f] &&
    candidates.some(
      (_, other) =>
        other !== c &&
        bestFileOf[other] === f &&
        scores[other][f] >= minSimilarity,
    );

  const scored: Array<{ c: number; f: number; score: number }> = [];
  for (const c of candidates.keys()) {
    for (const f of files.keys()) {
      if (isDisplacedEcho(c, f)) continue;
      scored.push({ c, f, score: scores[c][f] });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const takenCandidates = new Set<number>();
  const takenFiles = new Set<number>();
  const nameByCandidate = new Map<number, string>();
  for (const { c, f, score } of scored) {
    if (score < minSimilarity) break;
    if (takenCandidates.has(c) || takenFiles.has(f)) continue;
    takenCandidates.add(c);
    // An exact score tie against another still-free file means there is no
    // evidence which file this block belongs to — leave it unmatched rather
    // than routing by declaration order.
    const ambiguous = scored.some(
      (other) =>
        other.c === c &&
        other.f !== f &&
        !takenFiles.has(other.f) &&
        other.score === score,
    );
    if (ambiguous) continue;
    takenFiles.add(f);
    nameByCandidate.set(c, files[f].name);
  }

  return candidates.map((content, idx) => {
    const name = nameByCandidate.get(idx);
    return name ? { content, name } : null;
  });
}

function stripXmlTagBlocks(content: string, tagName: string): string {
  const trimmedTag = tagName.trim();
  if (!trimmedTag) {
    return content;
  }
  return content.replaceAll(
    new RegExp(
      `<${escapeRegExp(trimmedTag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(trimmedTag)}>`,
      'gi',
    ),
    '',
  );
}

export class XmlOutputManager {
  constructor(
    private readonly agentSetting: AgentSetting,
    private readonly agentConfig: AgentConfig,
    private readonly logger: AgentTrace,
    private readonly fileService: TaskRunFileService,
  ) {}

  async processXmlContent(content: string): Promise<string> {
    // applyNonRegex already applies all enabled non-regex categories
    // (including latex_xml), so no need to re-apply them.
    const normalized = replacementEngine.applyNonRegex(content);
    return applyReplacements(normalized, FENCED_LATEX_BLOCK_REPLACEMENTS);
  }

  private extractMultipleDocumentsbyRegex(
    outputContent: string,
    documentTag: string,
    preferredName?: string,
  ): Array<{ content: string; name: string }> | null {
    const result = extractDocuments(outputContent, documentTag, preferredName);

    if (result.documents) {
      const suffix =
        EXTRACTION_METHOD_MESSAGES[result.method] ?? 'using fallback method';
      logInternal(
        this.logger,
        `Recovered ${documentTag} ${suffix} (${formatResultCount(result.documents.length, 'document')})`,
      );
      return result.documents;
    }

    debugInternal(
      this.logger,
      `No ${documentTag} found in output file using fallback method`,
    );
    return null;
  }

  /** Count document tag occurrences with name attributes (case-sensitive to match extraction). */
  private countDocumentTags(content: string): number {
    return content.match(DOCUMENT_NAME_REGEX_GLOBAL)?.length ?? 0;
  }

  private warnPartialExtraction(
    outputLocation: FileLocation,
    expectedCount: number,
    extractedCount: number,
  ): void {
    if (expectedCount <= extractedCount) {
      return;
    }
    const missingCount = expectedCount - extractedCount;
    const missing = Array.from(
      { length: missingCount },
      (_, i) => `<unextracted document ${i + 1}>`,
    );

    logMissingOutputs(this.logger, {
      missing,
      xmlFile: outputLocation.absolutePath,
      documentTag: this.agentSetting.documentTag,
    });
  }

  private makeUniquePercentHeaderName(
    source: string,
    reservedFinalPaths: Set<string>,
    roundDir: string,
  ): string {
    const normalized = source.replaceAll('\\', '/');
    const safeName = getSafeDocumentRelativePath(normalized).replaceAll(
      '\\',
      '/',
    );
    let candidate = safeName;
    let suffix = 2;

    const finalPathKey = (name: string) =>
      getExtractedDocOutputFileName(name, roundDir).replaceAll('\\', '/');

    while (reservedFinalPaths.has(finalPathKey(candidate))) {
      const parsed = path.posix.parse(safeName);
      candidate = path.posix.join(
        parsed.dir,
        `${parsed.name}-${suffix}${parsed.ext}`,
      );
      suffix += 1;
    }

    reservedFinalPaths.add(finalPathKey(candidate));
    return candidate;
  }

  private extractPercentHeaderDocuments(
    outputContent: string,
    roundDir: string,
    thinkingTag: string,
  ): Array<{ content: string; name: string }> | null {
    const documents: Array<{ content: string; name: string }> = [];
    const reservedFinalPaths = new Set<string>();
    let currentName: string | null = null;
    let currentLines: string[] = [];
    let preHeaderLines: string[] = [];
    let pendingPrefacedMarkdownFence: MarkdownFence | null = null;
    let currentMarkdownFence: MarkdownFence | null = null;
    let ignoreProseUntilNextHeader = false;
    let synthesizedSingleInputFromPrefix = false;

    // Bare labels may only name files this agent is expected to write: the
    // declared outputFiles when present (single-artifact agents like ocr /
    // paper2slide, whose inputs can be media files a response might mention
    // in prose), otherwise the inputs (workflow edit agents reuse the input
    // names as output names).
    const labelFiles =
      this.agentConfig.outputFiles.length > 0
        ? this.agentConfig.outputFiles
        : this.agentConfig.inputFiles;

    const flushCurrent = (): MarkdownFence | null => {
      if (!currentName) return null;
      const content = stripSurroundingMarkdownFence(currentLines)
        .join('\n')
        .trim();
      const carriedFence = content ? null : currentMarkdownFence;
      if (content) {
        documents.push({
          name: this.makeUniquePercentHeaderName(
            currentName,
            reservedFinalPaths,
            roundDir,
          ),
          content,
        });
      }
      currentLines = [];
      currentMarkdownFence = null;
      return carriedFence;
    };

    const lines = stripSurroundingMarkdownFence(
      stripXmlTagBlocks(outputContent, thinkingTag)
        .replaceAll('\r\n', '\n')
        .replaceAll('\r', '\n')
        .split('\n'),
    );
    for (const [index, line] of lines.entries()) {
      const fence = parseMarkdownFenceDelimiter(line);

      if (!currentName && fence) {
        if (
          pendingPrefacedMarkdownFence &&
          isClosingMarkdownFence(line, pendingPrefacedMarkdownFence)
        ) {
          pendingPrefacedMarkdownFence = null;
        } else {
          pendingPrefacedMarkdownFence = fence;
        }
        ignoreProseUntilNextHeader = false;
        continue;
      }

      if (
        currentName &&
        currentMarkdownFence &&
        isClosingMarkdownFence(line, currentMarkdownFence) &&
        !getLatexDocumentContext(currentLines).insideDocumentBody
      ) {
        flushCurrent();
        currentName = null;
        preHeaderLines = [];
        pendingPrefacedMarkdownFence = null;
        ignoreProseUntilNextHeader = true;
        synthesizedSingleInputFromPrefix = false;
        continue;
      }

      const percentHeaderName =
        PERCENT_FILENAME_HEADER_REGEX.exec(line.trim())?.[1] ?? null;
      const headerName =
        percentHeaderName ?? matchKnownFileLabel(line, labelFiles);
      if (headerName && synthesizedSingleInputFromPrefix) {
        // A `%` header is a valid LaTeX comment and can stay in the
        // synthesized document's body; a bare label is not LaTeX, so drop it.
        if (percentHeaderName) {
          currentLines.push(line);
        }
        continue;
      }

      const linesBeforeHeader = currentName ? currentLines : preHeaderLines;
      if (
        headerName &&
        !shouldKeepPercentHeaderAsLatexComment(linesBeforeHeader, lines, index)
      ) {
        if (!currentName && hasLikelyLatexContent(preHeaderLines)) {
          if (this.agentConfig.inputFiles.length === 1) {
            currentName = this.agentConfig.inputFiles[0];
            currentLines = [...preHeaderLines, line];
            currentMarkdownFence = pendingPrefacedMarkdownFence;
            pendingPrefacedMarkdownFence = null;
            preHeaderLines = [];
            ignoreProseUntilNextHeader = false;
            synthesizedSingleInputFromPrefix = true;
            continue;
          }
          preHeaderLines = [];
        }
        const carriedFence = flushCurrent();
        currentName = headerName;
        currentMarkdownFence = pendingPrefacedMarkdownFence ?? carriedFence;
        pendingPrefacedMarkdownFence = null;
        preHeaderLines = [];
        ignoreProseUntilNextHeader = false;
        synthesizedSingleInputFromPrefix = false;
        continue;
      }

      if (currentName) {
        if (
          fence &&
          !currentMarkdownFence &&
          !currentLines.some((currentLine) => currentLine.trim() !== '')
        ) {
          currentMarkdownFence = fence;
          continue;
        }
        currentLines.push(line);
      } else if (!ignoreProseUntilNextHeader) {
        preHeaderLines.push(line);
      }
    }
    flushCurrent();

    if (documents.length === 0) return null;

    logInternal(
      this.logger,
      `Recovered ${this.agentSetting.documentTag} from filename headers (${formatResultCount(documents.length, 'document')})`,
    );
    return documents;
  }

  /**
   * Last-resort recovery for multi-input agents that returned fenced
   * ```latex/```tex blocks with no filename header at all (neither the
   * `%`-comment nor bare-label forms `extractPercentHeaderDocuments`
   * recognizes). Matches each fenced block against the agent's original
   * input files by content similarity rather than guessing from response
   * order, since a model can reorder or drop files in its response.
   */
  private async extractDocumentsByContentSimilarity(
    outputContent: string,
    outputLocation: FileLocation,
    thinkingTag: string,
    baseFiles: readonly FileLocation[],
  ): Promise<Array<{ content: string; name: string }> | null> {
    const blocks = collectLatexFencedBlocks(outputContent, thinkingTag);
    if (blocks.length === 0) return null;

    const inputFiles = this.agentConfig.inputFiles;
    const files = await Promise.all(
      baseFiles.slice(0, inputFiles.length).map(async (loc, idx) => ({
        name: inputFiles[idx],
        // An unreadable base file becomes '': it will score near-zero
        // similarity against any real fenced block rather than aborting the
        // whole recovery pass.
        content: await AbsoluteFS.read(loc.absolutePath).catch(() => ''),
      })),
    );
    if (files.length === 0) return null;

    const documents = assignByContentSimilarity(blocks, files).filter(
      (d): d is { content: string; name: string } => d !== null,
    );
    if (documents.length === 0) return null;

    logInternal(
      this.logger,
      `Recovered ${this.agentSetting.documentTag} by matching unlabeled fenced ` +
        `blocks against the original input files (${formatResultCount(documents.length, 'document')})`,
    );

    // Recovery is best-effort per block: surface what stayed unmatched so a
    // partially recovered round never silently reads as a complete one.
    const matchedNames = new Set(documents.map((doc) => doc.name));
    const unmatchedFiles = files
      .map((file) => file.name)
      .filter((name) => !matchedNames.has(name));
    if (unmatchedFiles.length > 0) {
      logMissingOutputs(this.logger, {
        missing: unmatchedFiles,
        xmlFile: outputLocation.absolutePath,
        documentTag: this.agentSetting.documentTag,
      });
    }
    if (documents.length < blocks.length) {
      debugInternal(
        this.logger,
        `${blocks.length - documents.length} of ${formatResultCount(blocks.length, 'fenced block')} matched no input file and were dropped`,
      );
    }
    return documents;
  }

  async splitScratchpadMultipleOutputXml(
    outputLocation: FileLocation,
    documentTag: string,
    round: number,
    thinkingTag: string = 'scratchpad',
    baseFiles: readonly FileLocation[] = [],
  ): Promise<OutputFileInfo[]> {
    const rawOutputContent = await AbsoluteFS.read(outputLocation.absolutePath);
    let outputContent = rawOutputContent;
    const expectedDocumentCount = this.countDocumentTags(outputContent);

    const tagsToWrap = [thinkingTag, 'document'];
    outputContent = addCdataToTagsMultiple(outputContent, tagsToWrap);

    let documents: Array<{ content: string; name: string }> | null = null;

    try {
      const parser = new XMLParser(XML_PARSER_OPTIONS);
      const root = parser.parse(outputContent);
      documents = extractContentFromXMLbyTagMultiple(root, documentTag);
      if (!documents) {
        debugInternal(
          this.logger,
          `No ${documentTag} found in parsed XML, attempting fallback extraction...`,
        );
      }
    } catch (err) {
      debugInternal(
        this.logger,
        `Failed to parse XML content: ${toErrorMessage(err)}, attempting fallback extraction...`,
      );
    }

    if (!documents) {
      documents = this.extractMultipleDocumentsbyRegex(
        outputContent,
        documentTag,
      );
    }

    if (!documents) {
      documents = this.extractPercentHeaderDocuments(
        rawOutputContent,
        getFileDirectory(outputLocation),
        thinkingTag,
      );
    }

    if (!documents) {
      // Single-input agents whose model regressed to a legacy single-doc shape
      // (<latex_document>, ```latex fence, or bare \documentclass) can still
      // be recovered: pass the primary input filename so the fallback can
      // synthesize a named document. Multi-input agents cannot safely recover
      // — without per-document names there's no way to route content.
      const inputFiles = this.agentConfig.inputFiles;
      // Keep the relative path verbatim — getExtractedDocOutputFileName
      // preserves subdirectories so `Draft/Draft1.tex` lands at the right
      // workspace location instead of collapsing to the round root.
      const preferredName = inputFiles.length === 1 ? inputFiles[0] : undefined;
      documents = this.extractMultipleDocumentsbyRegex(
        outputContent,
        documentTag,
        preferredName,
      );
    }

    if (
      !documents &&
      this.agentConfig.inputFiles.length > 1 &&
      this.agentConfig.outputFiles.length === 0
    ) {
      // Multi-input agents have no name to synthesize a single-document
      // recovery from, but an unlabeled fenced block can still be routed by
      // comparing it against each original input file's content. Only valid
      // when baseFiles really is the input files: runReflectionFlow.ts
      // substitutes config.outputFiles for baseFiles whenever the agent
      // declares any (single-artifact-from-many-inputs agents like ocr/
      // paper2slide), so zipping baseFiles[i] with inputFiles[i] there would
      // label a matched block with the wrong input filename.
      documents = await this.extractDocumentsByContentSimilarity(
        rawOutputContent,
        outputLocation,
        thinkingTag,
        baseFiles,
      );
    }

    if (!documents) {
      this.warnPartialExtraction(outputLocation, expectedDocumentCount, 0);
      return [];
    }

    this.warnPartialExtraction(
      outputLocation,
      expectedDocumentCount,
      documents.length,
    );
    return this.processMultipleLatexDocuments(documents, outputLocation, round);
  }

  async processMultipleLatexDocuments(
    latexDocuments: Array<{ content: string; name: string }>,
    outputLocation: FileLocation,
    round: number,
  ): Promise<OutputFileInfo[]> {
    const outputFiles: OutputFileInfo[] = [];
    // For workspace/runStorage outputs use the workspace-relative round dir
    // so fileService.createLocation can route through its storage layer.
    // For external outputs, work in absolute paths directly — an absolute
    // path passed through createLocation would be re-classified as external
    // anyway, so skip the round-trip and build the location explicitly.
    const isExternal = outputLocation.kind === 'external';
    const roundDir = getFileDirectory(outputLocation);

    for (const doc of latexDocuments) {
      if (!doc.name || doc.name === 'unknown' || !doc.content) {
        this.logger.debug(`Skipping document with empty name or content`);
        continue;
      }

      const source = doc.name.trim();
      if (!source) {
        this.logger.debug(
          `Skipping document with empty source name after trimming`,
        );
        continue;
      }

      const texFile = getExtractedDocOutputFileName(source, roundDir);
      const texLocation = isExternal
        ? createExternalLocation(texFile)
        : this.fileService.createLocation(texFile);
      const cleanedContent = this.cleanExtractedDocumentContent(
        doc.content.trim(),
        texFile,
      );
      await writeRoundOutput(texLocation.absolutePath, cleanedContent);
      outputFiles.push({
        source,
        round,
        location: texLocation,
        lineage: null,
        diff: null,
      });
      this.logger.debug(
        `XML Source: ${source} -> TeX file written: ${texFile}`,
      );
    }

    return outputFiles;
  }

  async ensureCorrectXmlStructure(
    fileLocation: FileLocation,
    documentTag: string,
  ): Promise<void> {
    this.logger.debug(
      `Ensuring correct XML structure: ${fileLocation.absolutePath}`,
    );
    const originalContent = await AbsoluteFS.read(fileLocation.absolutePath);
    let content = await this.processXmlContent(originalContent);

    const closeTag = `</${documentTag}>`;
    const openTag = `<${documentTag}>`;
    const hasOpenTag = content.includes(openTag);
    const hasCloseTag = content.includes(closeTag);

    if (hasOpenTag && !content.endsWith(closeTag)) {
      if (hasCloseTag) {
        content = content.replace(new RegExp(`${closeTag}.*$`, 's'), '');
      }
      content += `\n${closeTag}`;
    }

    if (content !== originalContent) {
      await AbsoluteFS.write(fileLocation.absolutePath, content);
    }
  }

  private cleanExtractedDocumentContent(
    content: string,
    fileName: string,
  ): string {
    const trimmed = content.trimEnd();

    const cleaned =
      trimmed.includes('\\begin{document}') ||
      !trimmed.endsWith('\\end{document}')
        ? trimmed
        : trimmed.replace(/\\end{document}\s*$/, '').trimEnd();

    if (cleaned !== trimmed) {
      this.logger.debug(`Removed trailing \\end{document} from ${fileName}`);
    }

    return cleaned === '' ? '' : `${cleaned}\n`;
  }
}
