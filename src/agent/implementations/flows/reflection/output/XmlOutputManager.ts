import * as path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { debugInternal, logInternal, type AgentTrace } from '@agent/trace';
import { reportMissingOutputs } from '@agent/runtime/runFactEvents';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import replacementEngine from '@replacement/engine';
import type { FileLocation, OutputFileInfo } from '@shared/schemas';
import { OUTPUT_DOCUMENT_TAG, OUTPUT_DOCUMENTS_TAG } from '@shared/schemas';
import { getExtractedDocOutputFileName } from '@utils/files/outputFileUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import {
  createExternalLocation,
  getFileDirectory,
} from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';
import { addCdataToTagsMultiple } from '@utils/text/xmlCdata';
import {
  DOCUMENT_NAME_REGEX,
  extractContentFromXMLbyTagMultiple,
  extractDocuments,
} from '@utils/text/xmlExtraction';

import {
  assignByContentSimilarity,
  collectLatexFencedBlocks as collectLatexFencedBlocksFromResponse,
} from './extraction/contentSimilarity';
import {
  extractFilenameHeaderDocuments,
  normalizeDocumentName,
} from './extraction/filenameHeaders';

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
  simple: 'using fallback method',
  latex_document: 'from legacy <latex_document> tag',
  markdown: 'from markdown code block',
  latex: 'from \\documentclass block',
};

export class XmlOutputManager {
  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly logger: AgentTrace,
    private readonly fileService: TaskRunFileService,
    private readonly streamId: string,
  ) {}

  private async processXmlContent(content: string): Promise<string> {
    return replacementEngine.applyXmlContent(content);
  }

  private extractMultipleDocumentsByRegex(
    outputContent: string,
    preferredName?: string,
  ): Array<{ content: string; name: string }> | null {
    const result = extractDocuments(
      outputContent,
      OUTPUT_DOCUMENTS_TAG,
      preferredName,
    );

    if (result.documents) {
      const suffix =
        EXTRACTION_METHOD_MESSAGES[result.method] ?? 'using fallback method';
      logInternal(
        this.logger,
        `Recovered ${OUTPUT_DOCUMENTS_TAG} ${suffix} (${formatResultCount(result.documents.length, 'document')})`,
      );
      return result.documents;
    }

    debugInternal(
      this.logger,
      `No ${OUTPUT_DOCUMENTS_TAG} found in output file using fallback method`,
    );
    return null;
  }

  private warnPartialExtraction(
    outputLocation: FileLocation,
    round: number,
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

    reportMissingOutputs(this.logger, {
      streamId: this.streamId,
      round,
      missing,
      xmlFile: outputLocation.absolutePath,
    });
  }

  private warnMissingExpectedFiles(
    outputLocation: FileLocation,
    round: number,
    expectedFiles: readonly string[],
    documents: ReadonlyArray<{ name: string }>,
  ): void {
    const recoveredNames = new Set(
      documents.map((doc) => normalizeDocumentName(doc.name)),
    );
    const missing = expectedFiles.filter(
      (name) => !recoveredNames.has(normalizeDocumentName(name)),
    );
    if (missing.length === 0) return;

    reportMissingOutputs(this.logger, {
      streamId: this.streamId,
      round,
      missing,
      xmlFile: outputLocation.absolutePath,
    });
  }

  private collectLatexFencedBlocks(
    outputContent: string,
    thinkingTag: string,
  ): string[] {
    return collectLatexFencedBlocksFromResponse(outputContent, thinkingTag, {
      onUnclosedFence: (lineCount) => {
        debugInternal(
          this.logger,
          `Dropped unclosed LaTeX fence with ${formatResultCount(lineCount, 'line')} during fallback extraction`,
        );
      },
    });
  }

  /**
   * Last-resort recovery for multi-input agents that returned fenced
   * ```latex/```tex blocks with no filename header at all (neither the
   * `%`-comment nor bare-label forms `extractFilenameHeaderDocuments`
   * recognizes). Matches each fenced block against the agent's original
   * input files by content similarity rather than guessing from response
   * order, since a model can reorder or drop files in its response.
   */
  private async extractDocumentsByContentSimilarity(
    outputContent: string,
    outputLocation: FileLocation,
    round: number,
    thinkingTag: string,
    baseFiles: readonly FileLocation[],
  ): Promise<Array<{ content: string; name: string }> | null> {
    const blocks = this.collectLatexFencedBlocks(outputContent, thinkingTag);
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
      `Recovered ${OUTPUT_DOCUMENTS_TAG} by matching unlabeled fenced ` +
        `blocks against the original input files (${formatResultCount(documents.length, 'document')})`,
    );

    // Recovery is best-effort per block: surface what stayed unmatched so a
    // partially recovered round never silently reads as a complete one.
    const matchedNames = new Set(documents.map((doc) => doc.name));
    const unmatchedFiles = files
      .map((file) => file.name)
      .filter((name) => !matchedNames.has(name));
    if (unmatchedFiles.length > 0) {
      reportMissingOutputs(this.logger, {
        streamId: this.streamId,
        round,
        missing: unmatchedFiles,
        xmlFile: outputLocation.absolutePath,
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
    round: number,
    thinkingTag: string = 'scratchpad',
    baseFiles: readonly FileLocation[] = [],
  ): Promise<OutputFileInfo[]> {
    const rawOutputContent = await AbsoluteFS.read(outputLocation.absolutePath);
    // Count document tag occurrences with name attributes (case-sensitive to
    // match extraction).
    const expectedDocumentCount =
      rawOutputContent.match(DOCUMENT_NAME_REGEX_GLOBAL)?.length ?? 0;

    // The XML-parse and regex tiers read the CDATA-wrapped variant (so the
    // parser treats thinking/document bodies as opaque text); the header and
    // similarity tiers below read the raw response instead.
    const cdataWrapped = addCdataToTagsMultiple(rawOutputContent, [
      thinkingTag,
      OUTPUT_DOCUMENT_TAG,
    ]);

    let documents: Array<{ content: string; name: string }> | null = null;

    try {
      const parser = new XMLParser(XML_PARSER_OPTIONS);
      const root = parser.parse(cdataWrapped);
      documents = extractContentFromXMLbyTagMultiple(
        root,
        OUTPUT_DOCUMENTS_TAG,
      );
      if (!documents) {
        debugInternal(
          this.logger,
          `No ${OUTPUT_DOCUMENTS_TAG} found in parsed XML, attempting fallback extraction...`,
        );
      }
    } catch (err) {
      debugInternal(
        this.logger,
        `Failed to parse XML content: ${toErrorMessage(err)}, attempting fallback extraction...`,
      );
    }

    if (!documents) {
      documents = this.extractMultipleDocumentsByRegex(cdataWrapped);
    }

    // The files this agent is expected to write: the declared outputFiles
    // when present (single-artifact agents like ocr / paper2slide, whose
    // inputs can be media files a response might mention in prose),
    // otherwise the inputs (workflow edit agents reuse the input names as
    // output names). Bare labels may only name these, and single-document
    // synthesis may only use one of these — never an input name when the
    // agent declares a different output.
    const expectedFiles =
      this.agentConfig.outputFiles.length > 0
        ? this.agentConfig.outputFiles
        : this.agentConfig.inputFiles;
    const soleExpectedFile =
      expectedFiles.length === 1 ? expectedFiles[0] : null;

    if (!documents) {
      documents = extractFilenameHeaderDocuments(rawOutputContent, {
        thinkingTag,
        roundDir: getFileDirectory(outputLocation),
        labelFiles: expectedFiles,
        synthesisName: soleExpectedFile,
        coalesceRepeatedName:
          this.agentConfig.outputFiles.length === 1 ? soleExpectedFile : null,
        wrapperTag: OUTPUT_DOCUMENTS_TAG,
      });
      if (documents) {
        logInternal(
          this.logger,
          `Recovered ${OUTPUT_DOCUMENTS_TAG} from filename headers (${formatResultCount(documents.length, 'document')})`,
        );
        if (expectedFiles.length > 1) {
          this.warnMissingExpectedFiles(
            outputLocation,
            round,
            expectedFiles,
            documents,
          );
        }
      }
    }

    if (
      !documents &&
      this.agentConfig.outputFiles.length === 1 &&
      soleExpectedFile
    ) {
      // This fully unlabeled tier is intentionally stricter than
      // filename-header recovery: without a trusted file label, only fences
      // explicitly marked latex/tex are treated as output.
      const fencedBlocks = this.collectLatexFencedBlocks(
        rawOutputContent,
        thinkingTag,
      );
      if (fencedBlocks.length > 1) {
        documents = [
          {
            name: soleExpectedFile,
            content: fencedBlocks.join('\n\n'),
          },
        ];
        logInternal(
          this.logger,
          `Recovered ${OUTPUT_DOCUMENTS_TAG} by concatenating ` +
            `unlabeled fenced blocks under ${soleExpectedFile} (${formatResultCount(fencedBlocks.length, 'block')})`,
        );
      }
    }

    if (!documents && soleExpectedFile) {
      // Agents expected to write exactly one file whose model regressed to a
      // legacy single-doc shape (<latex_document>, ```latex fence, or bare
      // \documentclass) can still be recovered: pass that filename so the
      // fallback can synthesize a named document. Agents with several
      // expected files cannot safely recover — without per-document names
      // there's no way to route content (and without a preferredName this
      // call would just repeat the earlier one).
      // Keep the relative path verbatim — getExtractedDocOutputFileName
      // preserves subdirectories so `Draft/Draft1.tex` lands at the right
      // workspace location instead of collapsing to the round root.
      documents = this.extractMultipleDocumentsByRegex(
        cdataWrapped,
        soleExpectedFile,
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
        round,
        thinkingTag,
        baseFiles,
      );
    }

    if (!documents) {
      this.warnPartialExtraction(
        outputLocation,
        round,
        expectedDocumentCount,
        0,
      );
      return [];
    }

    this.warnPartialExtraction(
      outputLocation,
      round,
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
      this.logger.debug('XML source written to TeX file', {
        data: { source, texFile },
      });
    }

    return outputFiles;
  }

  async ensureCorrectXmlStructure(fileLocation: FileLocation): Promise<void> {
    this.logger.debug(
      `Ensuring correct XML structure: ${fileLocation.absolutePath}`,
    );
    const originalContent = await AbsoluteFS.read(fileLocation.absolutePath);
    let content = await this.processXmlContent(originalContent);

    const closeTag = `</${OUTPUT_DOCUMENTS_TAG}>`;
    const openTag = `<${OUTPUT_DOCUMENTS_TAG}>`;
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
