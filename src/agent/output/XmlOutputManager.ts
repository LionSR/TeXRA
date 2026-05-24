import * as path from 'path';

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
import { WORKFLOW_OUTPUT_BASENAME } from '@agent/output/workflowOutputLayout';
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
  addCdataToTags,
  addCdataToTagsMultiple,
  DOCUMENT_NAME_REGEX,
  extractContentFromXMLbyTag,
  extractContentFromXMLbyTagMultiple,
  extractDocument,
  extractDocuments,
} from '@utils/text/xmlUtils';

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
    // (including latex_xml and scratchpad_xml), so no need to re-apply them.
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

  async splitScratchpadOutputXml(
    outputLocation: FileLocation,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<{ location: FileLocation; sourceName: string }> {
    const { name: rawStem } = path.parse(outputLocation.absolutePath);
    const outputDir = getFileDirectory(outputLocation);

    // Read content first so we can derive the destination name from the
    // XML document-name attribute before creating the output location.
    let outputContent = await AbsoluteFS.read(outputLocation.absolutePath);
    const sourceName =
      outputContent.match(DOCUMENT_NAME_REGEX)?.[1]?.trim() ?? '';

    // Name the extracted .tex after: primary input file stem → first XML
    // document name → raw output stem. The primary input takes priority
    // because extractDocument() also uses inputFiles[0] as its matching hint,
    // so the destination name and the extracted content stay in sync. For
    // agents without an input, the XML document name is a human-readable
    // fallback.
    const primaryInput = this.agentConfig.inputFiles[0] ?? '';
    const inputFileStem = primaryInput ? path.parse(primaryInput).name : '';
    // sourceName comes from model XML and may carry path components or a .tex
    // extension — strip both.  inputFileStem and rawStem are already clean stems.
    const safeSourceName = sourceName
      ? path.parse(path.basename(sourceName)).name
      : '';
    const stemCandidate = inputFileStem || safeSourceName || rawStem;
    // Guard: don't write the extracted .tex to the same path as the raw output.
    const texStem =
      stemCandidate === WORKFLOW_OUTPUT_BASENAME
        ? `${WORKFLOW_OUTPUT_BASENAME}_extracted`
        : stemCandidate;
    const texRelativePath = outputDir
      ? path.join(outputDir, `${texStem}.tex`)
      : `${texStem}.tex`;

    const texLocation = this.fileService.createLocation(texRelativePath);

    const tagsToWrap = [documentTag, thinkingTag];
    outputContent = addCdataToTags(outputContent, tagsToWrap);

    const filename = primaryInput ? path.basename(primaryInput) : '';
    const regexResult = extractDocument(outputContent, documentTag, filename);
    if (regexResult.content) {
      const suffix = EXTRACTION_METHOD_MESSAGES[regexResult.method];
      if (suffix)
        logInternal(this.logger, `Recovered ${documentTag} ${suffix}`);
      await AbsoluteFS.write(texLocation.absolutePath, regexResult.content);
      return { location: texLocation, sourceName };
    }
    debugInternal(
      this.logger,
      `No ${documentTag} found in output file using fallback method`,
    );

    const parser = new XMLParser(XML_PARSER_OPTIONS);
    const root = parser.parse(outputContent);

    const latexDocument = extractContentFromXMLbyTag(root, documentTag);
    if (latexDocument) {
      await AbsoluteFS.write(texLocation.absolutePath, latexDocument);
      return { location: texLocation, sourceName };
    }
    throw new Error(
      `Failed to extract <${documentTag}> from ${path.basename(outputLocation.absolutePath)}`,
    );
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
      await AbsoluteFS.write(texLocation.absolutePath, cleanedContent);
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

  async processSingleXmlOutput(
    outputLocation: FileLocation,
    round: number,
  ): Promise<OutputFileInfo> {
    this.logger.debug(
      `Splitting scratchpad output XML: ${outputLocation.absolutePath}`,
    );

    const { location, sourceName } = await this.splitScratchpadOutputXml(
      outputLocation,
      this.agentSetting.documentTag,
    );

    return {
      source: sourceName || (this.agentConfig.inputFiles[0] ?? ''),
      round,
      location,
      lineage: null,
      diff: null,
    };
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
