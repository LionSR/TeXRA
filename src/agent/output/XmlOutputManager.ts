import { XMLParser } from 'fast-xml-parser';

import {
  debugInternal,
  logInternal,
  logMissingOutputs,
  type AgentTrace,
} from '@agent/trace';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting } from '@agent/core/AgentDataclass';
import { getExtractedDocOutputFileName } from '@agent/utils/outputFileUtils';
import { toErrorMessage } from '@common/errors';
import replacementEngine, { applyReplacements } from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import type { OutputFileInfo } from '@shared/schemas';
import {
  AbsoluteFS,
  createExternalLocation,
  getFileDirectory,
  TaskRunFileService,
  type FileLocation,
} from '@utils/files';
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
    content = replacementEngine.applyNonRegex(content);
    content = applyReplacements(content, FENCED_LATEX_BLOCK_REPLACEMENTS);

    return content;
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
        `Recovered ${documentTag} ${suffix} (${result.documents.length} document${result.documents.length === 1 ? '' : 's'})`,
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

  async splitScratchpadMultipleOutputXml(
    outputLocation: FileLocation,
    documentTag: string,
    round: number,
    thinkingTag: string = 'scratchpad',
  ): Promise<OutputFileInfo[]> {
    let outputContent = await AbsoluteFS.read(outputLocation.absolutePath);
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
      const cleanedContent = this.removeTrailingEndDocument(
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

  private removeTrailingEndDocument(content: string, fileName: string): string {
    const trimmed = content.trimEnd();

    if (
      trimmed.includes('\\begin{document}') ||
      !trimmed.endsWith('\\end{document}')
    ) {
      return trimmed;
    }

    this.logger.debug(`Removed trailing \\end{document} from ${fileName}`);
    return trimmed.replace(/\\end{document}\s*$/, '');
  }
}
