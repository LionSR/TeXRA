// Standard library imports
import * as path from 'path';

// Third-party imports
import { XMLParser } from 'fast-xml-parser';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentSetting } from '@agent/core/AgentDataclass';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  applyReplacements,
  getReplacementsByCategory,
} from '@replacement/engine';
import replacementEngine from '@replacement/engine';
import { FENCED_LATEX_BLOCK_REPLACEMENTS } from '@replacement/rulesRegex';
import { AbsoluteFS, TaskRunFileService } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

// Local file imports
import type { OutputFile, OutputFileInfo } from './types';

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

  private extractDocumentbyRegex(
    outputContent: string,
    documentTag: string,
  ): string | null {
    const filename = path.basename(this.agentConfig.inputFile);
    const result = xmlUtils.extractDocument(
      outputContent,
      documentTag,
      filename,
    );

    if (result.content) {
      switch (result.method) {
        case 'named':
          this.logger.info(
            `Recovered ${documentTag} from named document tag`,
            undefined,
            MESSAGE_TYPES.INTERNAL,
          );
          break;
        case 'simple':
          this.logger.info(
            `Successfully extracted ${documentTag} using fallback method`,
            undefined,
            MESSAGE_TYPES.INTERNAL,
          );
          break;
        case 'markdown':
          this.logger.info(
            `Recovered ${documentTag} from markdown code block`,
            undefined,
            MESSAGE_TYPES.INTERNAL,
          );
          break;
        case 'latex':
          this.logger.info(
            `Recovered ${documentTag} from \\documentclass block`,
            undefined,
            MESSAGE_TYPES.INTERNAL,
          );
          break;
      }
      return result.content;
    }

    this.logger.debug(
      `No ${documentTag} found in output file using fallback method`,
      undefined,
      MESSAGE_TYPES.INTERNAL,
    );
    return null;
  }

  private extractMultipleDocumentsbyRegex(
    outputContent: string,
    documentTag: string,
  ): Array<{ content: string; name: string }> | null {
    const result = xmlUtils.extractDocuments(outputContent, documentTag);

    if (result.documents) {
      this.logger.info(
        `Successfully extracted multiple ${documentTag} using fallback method`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return result.documents;
    }

    this.logger.debug(
      `No ${documentTag} found in output file using fallback method`,
      undefined,
      MESSAGE_TYPES.INTERNAL,
    );
    return null;
  }

  async splitScratchpadOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<string> {
    const outputLocation = this.fileService.resolveRelativePath(outputFile);
    const { dir, name } = path.parse(outputLocation.absolutePath);
    const texFile = path.join(dir, `${name}.tex`);

    let outputContent = await AbsoluteFS.read(outputLocation.absolutePath);
    const tagsToWrap = [documentTag, thinkingTag];
    outputContent = xmlUtils.addCdataToTags(outputContent, tagsToWrap);

    // First, try to extract named document matching input file (prioritized)
    const namedDocumentContent = this.extractDocumentbyRegex(
      outputContent,
      documentTag,
    );
    if (namedDocumentContent) {
      await AbsoluteFS.write(texFile, namedDocumentContent);
      return texFile;
    }

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: true,
        textNodeName: 'content',
        attributeNamePrefix: '',
        processEntities: false,
        ignoreDeclaration: true,
      });
      const root = parser.parse(outputContent);

      const latexDocument = xmlUtils.extractContentFromXMLbyTag(
        root,
        documentTag,
      );
      if (latexDocument) {
        await AbsoluteFS.write(texFile, latexDocument);
        return texFile;
      }
      throw new Error(
        `Failed to extract <${documentTag}> from ${path.basename(outputFile)}`,
      );
    } catch (err) {
      throw err;
    }
  }

  async splitScratchpadMultipleOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<OutputFileInfo[]> {
    const outputLocation = this.fileService.resolveRelativePath(outputFile);
    let outputContent = await AbsoluteFS.read(outputLocation.absolutePath);

    const tagsToWrap = [thinkingTag, 'document'];
    outputContent = xmlUtils.addCdataToTagsMultiple(outputContent, tagsToWrap);

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: true,
        textNodeName: 'content',
        attributeNamePrefix: '',
        processEntities: false,
        ignoreDeclaration: true,
      });
      const root = parser.parse(outputContent);

      const documents = xmlUtils.extractContentFromXMLbyTagMultiple(
        root,
        documentTag,
      );
      if (documents) {
        return this.processMultipleLatexDocuments(documents, outputFile);
      }
      this.logger.debug(
        `No ${documentTag} found in parsed XML, attempting fallback extraction...`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      const fallbackDocuments = this.extractMultipleDocumentsbyRegex(
        outputContent,
        documentTag,
      );
      if (fallbackDocuments) {
        return this.processMultipleLatexDocuments(
          fallbackDocuments,
          outputFile,
        );
      }
      return [];
    } catch (err) {
      this.logger.debug(
        `Failed to parse XML content: ${toErrorMessage(err)}, attempting fallback extraction...`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      const fallbackDocuments = this.extractMultipleDocumentsbyRegex(
        outputContent,
        documentTag,
      );
      if (fallbackDocuments) {
        return this.processMultipleLatexDocuments(
          fallbackDocuments,
          outputFile,
        );
      }
      throw err;
    }
  }

  /**
   * Build minimal output file info from source and path.
   * Lineage and diff stats are added later by OutputHandler.
   */
  private buildOutputFileInfo(
    source: string,
    outputPath: string,
  ): OutputFileInfo {
    return {
      source,
      location: this.fileService.resolveRelativePath(outputPath),
      lineage: null,
      diff: null,
    };
  }

  /**
   * Build a clean output file reference (new simplified format).
   */
  private buildOutputFile(source: string, outputPath: string): OutputFile {
    const location = this.fileService.resolveRelativePath(outputPath);
    return {
      source,
      location,
    };
  }

  async processMultipleLatexDocuments(
    latexDocuments: Array<{ content: string; name: string }>,
    outputFile: string,
  ): Promise<OutputFileInfo[]> {
    const outputFiles: OutputFileInfo[] = [];
    const outputParts = path.basename(outputFile).split('_');
    const agent = outputParts.at(-3) ?? '';
    const model = outputParts.at(-1)?.split('.')[0] ?? '';

    const roundMatch = outputFile.match(/_r(\d+)_/);
    const currRound = roundMatch ? parseInt(roundMatch[1]) : 0;

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
      const texFile = getOutputFileName(
        source,
        agent,
        model,
        extension,
        currRound,
      );
      const outputLocation = this.fileService.resolveRelativePath(texFile);
      await AbsoluteFS.write(outputLocation.absolutePath, doc.content.trim());
      outputFiles.push(this.buildOutputFileInfo(source, texFile));
      this.logger.debug(
        `XML Source: ${source} -> TeX file written: ${texFile}`,
      );
    }

    return outputFiles;
  }

  async processSingleXmlOutput(outputFile: string): Promise<OutputFileInfo> {
    this.logger.debug(`Splitting scratchpad output XML: ${outputFile}`);

    const processedOutputFile = await this.splitScratchpadOutputXml(
      outputFile,
      this.agentSetting.documentTag,
    );

    const xmlLocation = this.fileService.resolveRelativePath(outputFile);
    const xmlContent = await AbsoluteFS.read(xmlLocation.absolutePath);
    let original = '';
    const nameMatch = xmlContent.match(/<document[^>]*name="(.*?)"[^>]*>/);
    if (nameMatch && nameMatch[1]) {
      original = nameMatch[1].trim();
    }

    return this.buildOutputFileInfo(
      original || this.agentConfig.inputFile,
      processedOutputFile,
    );
  }

  async processMultipleXmlOutputs(
    outputFile: string,
  ): Promise<OutputFileInfo[]> {
    this.logger.debug(
      `Splitting multiple scratchpad output XML: ${outputFile}`,
    );
    const processedOutputFiles = await this.splitScratchpadMultipleOutputXml(
      outputFile,
      this.agentSetting.documentTag,
    );
    return processedOutputFiles;
  }

  async ensureCorrectXmlStructure(
    filePath: string,
    documentTag: string,
  ): Promise<void> {
    this.logger.debug(`Ensuring correct XML structure: ${filePath}`);
    const xmlLocation = this.fileService.resolveRelativePath(filePath);
    const originalContent = await AbsoluteFS.read(xmlLocation.absolutePath);
    let content = await this.processXmlContent(originalContent);

    let fixed = false;
    if (!content.endsWith(`</${documentTag}>`)) {
      if (
        !content.includes(`</${documentTag}>`) &&
        content.includes(`<${documentTag}>`)
      ) {
        fixed = true;
        content += `\n</${documentTag}>`;
      } else if (content.includes(`<${documentTag}>`)) {
        fixed = true;
        content = content.replace(new RegExp(`</${documentTag}>.*$`, 's'), '');
        content += `\n</${documentTag}>`;
      }
    }

    if (fixed || content !== originalContent) {
      await AbsoluteFS.write(xmlLocation.absolutePath, content);
    }
  }
}
