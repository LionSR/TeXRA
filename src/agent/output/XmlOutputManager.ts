import * as path from 'path';

import { XMLParser } from 'fast-xml-parser';

import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting } from '@agent/core/AgentDataclass';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { AgentLogger } from '@logger/AgentLogger';
import replacementEngine, {
  applyReplacements,
  getReplacementsByCategory,
} from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import {
  AbsoluteFS,
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
import type { OutputFileInfo } from '@shared/schemas';

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

export class XmlOutputManager {
  constructor(
    private readonly agentSetting: AgentSetting,
    private readonly agentConfig: AgentConfig,
    private readonly logger: AgentLogger,
    private readonly fileService: TaskRunFileService,
  ) {}

  async processXmlContent(content: string): Promise<string> {
    content = replacementEngine.applyNonRegex(content);
    content = applyReplacements(content, FENCED_LATEX_BLOCK_REPLACEMENTS);

    const latexXmlReplacements = getReplacementsByCategory('latex_xml');
    if (latexXmlReplacements) {
      content = applyReplacements(content, latexXmlReplacements);
    }

    const scratchpadXmlReplacements =
      getReplacementsByCategory('scratchpad_xml');
    if (scratchpadXmlReplacements) {
      content = applyReplacements(content, scratchpadXmlReplacements);
    }

    return content;
  }

  private static readonly EXTRACTION_METHOD_MESSAGES: Record<string, string> = {
    named: 'from named document tag',
    simple: 'using fallback method',
    markdown: 'from markdown code block',
    latex: 'from \\documentclass block',
  };

  private extractDocumentbyRegex(
    outputContent: string,
    documentTag: string,
  ): string | null {
    const filename = path.basename(this.agentConfig.inputFile);
    const result = extractDocument(outputContent, documentTag, filename);

    if (!result.content) {
      this.logger.debugInternal(
        `No ${documentTag} found in output file using fallback method`,
      );
      return null;
    }

    const suffix = XmlOutputManager.EXTRACTION_METHOD_MESSAGES[result.method];
    if (suffix) {
      this.logger.logInternal(`Recovered ${documentTag} ${suffix}`);
    }
    return result.content;
  }

  private extractMultipleDocumentsbyRegex(
    outputContent: string,
    documentTag: string,
  ): Array<{ content: string; name: string }> | null {
    const result = extractDocuments(outputContent, documentTag);

    if (result.documents) {
      this.logger.logInternal(
        `Successfully extracted multiple ${documentTag} using fallback method`,
      );
      return result.documents;
    }

    this.logger.debugInternal(
      `No ${documentTag} found in output file using fallback method`,
    );
    return null;
  }

  async splitScratchpadOutputXml(
    outputLocation: FileLocation,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<FileLocation> {
    const { name } = path.parse(outputLocation.absolutePath);
    const texFilename = `${name}.tex`;

    const outputDir = getFileDirectory(outputLocation);
    const texRelativePath = outputDir
      ? path.join(outputDir, texFilename)
      : texFilename;

    const texLocation = this.fileService.createLocation(texRelativePath);

    let outputContent = await AbsoluteFS.read(outputLocation.absolutePath);
    const tagsToWrap = [documentTag, thinkingTag];
    outputContent = addCdataToTags(outputContent, tagsToWrap);

    const namedDocumentContent = this.extractDocumentbyRegex(
      outputContent,
      documentTag,
    );
    if (namedDocumentContent) {
      await AbsoluteFS.write(texLocation.absolutePath, namedDocumentContent);
      return texLocation;
    }

    const parser = new XMLParser(XML_PARSER_OPTIONS);
    const root = parser.parse(outputContent);

    const latexDocument = extractContentFromXMLbyTag(root, documentTag);
    if (latexDocument) {
      await AbsoluteFS.write(texLocation.absolutePath, latexDocument);
      return texLocation;
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
    if (expectedCount > 0 && expectedCount > extractedCount) {
      // Generate placeholder names for the missing documents
      const missingCount = expectedCount - extractedCount;
      const missing = Array.from(
        { length: missingCount },
        (_, i) => `<unextracted document ${i + 1}>`,
      );

      this.logger.missingOutputs({
        missing,
        xmlFile: outputLocation.absolutePath,
        documentTag: this.agentSetting.documentTag,
      });
    }
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

    const tryFallbackExtraction = async (): Promise<
      OutputFileInfo[] | null
    > => {
      const fallbackDocs = this.extractMultipleDocumentsbyRegex(
        outputContent,
        documentTag,
      );
      if (fallbackDocs) {
        this.warnPartialExtraction(
          outputLocation,
          expectedDocumentCount,
          fallbackDocs.length,
        );
        return this.processMultipleLatexDocuments(
          fallbackDocs,
          outputLocation,
          round,
        );
      }
      this.warnPartialExtraction(outputLocation, expectedDocumentCount, 0);
      return null;
    };

    try {
      const parser = new XMLParser(XML_PARSER_OPTIONS);
      const root = parser.parse(outputContent);

      const documents = extractContentFromXMLbyTagMultiple(root, documentTag);
      if (documents) {
        this.warnPartialExtraction(
          outputLocation,
          expectedDocumentCount,
          documents.length,
        );
        return this.processMultipleLatexDocuments(
          documents,
          outputLocation,
          round,
        );
      }

      this.logger.debugInternal(
        `No ${documentTag} found in parsed XML, attempting fallback extraction...`,
      );
      return (await tryFallbackExtraction()) ?? [];
    } catch (err) {
      this.logger.debugInternal(
        `Failed to parse XML content: ${toErrorMessage(err)}, attempting fallback extraction...`,
      );
      const result = await tryFallbackExtraction();
      if (result) return result;
      throw err;
    }
  }

  async processMultipleLatexDocuments(
    latexDocuments: Array<{ content: string; name: string }>,
    outputLocation: FileLocation,
    round: number,
  ): Promise<OutputFileInfo[]> {
    const outputFiles: OutputFileInfo[] = [];
    const outputParts = path.basename(outputLocation.absolutePath).split('_');
    const agent = outputParts.at(-3) ?? '';
    const model = outputParts.at(-1)?.split('.')[0] ?? '';

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

      const { ext } = path.parse(source);
      const extension = ext.replace('.', '') || 'tex';
      const texFile = getOutputFileName(source, agent, model, extension, round);
      const texLocation = this.fileService.createLocation(texFile);
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

    const processedTexLocation = await this.splitScratchpadOutputXml(
      outputLocation,
      this.agentSetting.documentTag,
    );

    const xmlContent = await AbsoluteFS.read(outputLocation.absolutePath);
    let original = '';
    const nameMatch = xmlContent.match(DOCUMENT_NAME_REGEX);
    if (nameMatch && nameMatch[1]) {
      original = nameMatch[1].trim();
    }

    return {
      source: original || this.agentConfig.inputFile,
      round,
      location: processedTexLocation,
      lineage: null,
      diff: null,
    };
  }

  async processMultipleXmlOutputs(
    outputLocation: FileLocation,
    round: number,
  ): Promise<OutputFileInfo[]> {
    this.logger.debug(
      `Splitting multiple scratchpad output XML: ${outputLocation.absolutePath}`,
    );
    return this.splitScratchpadMultipleOutputXml(
      outputLocation,
      this.agentSetting.documentTag,
      round,
    );
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
    const trimmedContent = content.trimEnd();

    if (
      !trimmedContent.includes('\\begin{document}') &&
      trimmedContent.endsWith('\\end{document}')
    ) {
      this.logger.debug(`Removed trailing \\end{document} from ${fileName}`);
      return trimmedContent.replace(/\\end{document}\s*$/, '');
    }

    return trimmedContent;
  }
}
