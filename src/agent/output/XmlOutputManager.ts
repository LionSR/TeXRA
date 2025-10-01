// Standard library imports
import * as path from 'path';

// Third-party imports
import { XMLParser } from 'fast-xml-parser';

// Local imports - agent
import { NamedOutputFile } from './types';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting } from '@agent/core/AgentDataclass';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  applyReplacements,
  getReplacementsByCategory,
} from '@replacement/engine';
import replacementEngine from '@replacement/engine';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';

export class XmlOutputManager {
  constructor(
    private readonly agentSetting: AgentSetting,
    private readonly agentConfig: AgentConfig,
    private readonly logger: AgentLogger,
  ) {}

  private async readOutputFile(filePath: string): Promise<string> {
    return path.isAbsolute(filePath)
      ? await AbsoluteFS.read(filePath)
      : await WorkspaceFS.read(filePath);
  }

  private async writeOutputFile(
    filePath: string,
    content: string,
  ): Promise<void> {
    if (path.isAbsolute(filePath)) {
      await AbsoluteFS.write(filePath, content);
    } else {
      await WorkspaceFS.write(filePath, content);
    }
  }

  private getWorkspaceTexPath(xmlFile: string): string {
    const { name } = path.parse(xmlFile);
    const inputDir = path.dirname(this.agentConfig.inputFile);
    const texPath = path.join(inputDir, `${name}.tex`);
    return path.isAbsolute(texPath)
      ? WorkspaceFS.relativePath(texPath)
      : texPath;
  }

  async processXmlContent(content: string): Promise<string> {
    content = replacementEngine.applyNonRegex(content);

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
    try {
      const documents = xmlUtils.extractMultipleTextFromTag(outputContent);
      if (documents && documents.length > 0) {
        const filename = path.basename(this.agentConfig.inputFile);
        const match = documents.find((doc) => doc.name === filename);
        if (match && match.content) {
          this.logger.info(
            `Recovered ${documentTag} from named document tag`,
            undefined,
            MESSAGE_TYPES.INTERNAL,
          );
          return match.content;
        }
      }
      const fallbackContent = xmlUtils.extractTextFromTag(
        outputContent,
        documentTag,
      );
      if (fallbackContent) {
        this.logger.info(
          `Successfully extracted ${documentTag} using fallback method`,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
        return fallbackContent;
      }
      const markdownFallback = xmlUtils.extractLatexFromMarkdown(outputContent);
      if (markdownFallback) {
        this.logger.info(
          `Recovered ${documentTag} from markdown code block`,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
        return markdownFallback;
      }
      const latexFallback =
        xmlUtils.extractLatexBetweenDocumentClass(outputContent);
      if (latexFallback) {
        this.logger.info(
          `Recovered ${documentTag} from \\documentclass block`,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
        return latexFallback;
      }
      this.logger.debug(
        `No ${documentTag} found in output file using fallback method`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return null;
    } catch (fallbackErr) {
      this.logger.debug(
        `Failed fallback extraction: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return null;
    }
  }

  private extractMultipleDocumentsbyRegex(
    outputContent: string,
    documentTag: string,
  ): Array<{ content: string; name: string }> | null {
    try {
      const fallbackDocuments = xmlUtils.extractMultipleTextFromTag(
        outputContent,
        documentTag,
      );
      if (fallbackDocuments && fallbackDocuments.length > 0) {
        this.logger.info(
          `Successfully extracted multiple ${documentTag} using fallback method`,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
        return fallbackDocuments;
      }
      this.logger.error(
        `No ${documentTag} found in output file using fallback method`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return null;
    } catch (err) {
      this.logger.error(
        `Failed fallback extraction: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      return null;
    }
  }

  async splitScratchpadOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<string> {
    const texFile = this.getWorkspaceTexPath(outputFile);

    let outputContent = await this.readOutputFile(outputFile);
    const tagsToWrap = [documentTag, thinkingTag];
    outputContent = xmlUtils.addCdataToTags(outputContent, tagsToWrap);

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
        await WorkspaceFS.write(texFile, latexDocument);
        return texFile;
      }
      this.logger.debug(
        `No ${documentTag} found in parsed XML, attempting fallback extraction...`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      const fallbackContent = this.extractDocumentbyRegex(
        outputContent,
        documentTag,
      );
      if (fallbackContent) {
        await WorkspaceFS.write(texFile, fallbackContent);
        return texFile;
      }
      throw new Error(
        `Failed to extract <${documentTag}> from ${path.basename(outputFile)}`,
      );
    } catch (err) {
      this.logger.debug(
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}, attempting fallback extraction...`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
      const fallbackContent = this.extractDocumentbyRegex(
        outputContent,
        documentTag,
      );
      if (fallbackContent) {
        await WorkspaceFS.write(texFile, fallbackContent);
        return texFile;
      }
      throw err;
    }
  }

  async splitScratchpadMultipleOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<NamedOutputFile[]> {
    let outputContent = await this.readOutputFile(outputFile);

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
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}, attempting fallback extraction...`,
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

  async processMultipleLatexDocuments(
    latexDocuments: Array<{ content: string; name: string }>,
    outputFile: string,
  ): Promise<NamedOutputFile[]> {
    const outputFiles: NamedOutputFile[] = [];
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
      await WorkspaceFS.write(texFile, doc.content.trim());
      outputFiles.push({ source, path: texFile });
      this.logger.debug(
        `XML Source: ${source} -> TeX file written: ${texFile}`,
      );
    }

    return outputFiles;
  }

  async processSingleXmlOutput(outputFile: string): Promise<NamedOutputFile> {
    this.logger.debug(`Splitting scratchpad output XML: ${outputFile}`);

    const processedOutputFile = await this.splitScratchpadOutputXml(
      outputFile,
      this.agentSetting.documentTag,
    );

    const xmlContent = await this.readOutputFile(outputFile);
    let original = '';
    const nameMatch = xmlContent.match(/<document[^>]*name="(.*?)"[^>]*>/);
    if (nameMatch && nameMatch[1]) {
      original = nameMatch[1].trim();
    }

    return {
      source: original || this.agentConfig.inputFile,
      path: processedOutputFile,
    };
  }

  async processMultipleXmlOutputs(
    outputFile: string,
  ): Promise<NamedOutputFile[]> {
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
    let content = await this.readOutputFile(filePath);

    content = await this.processXmlContent(content);

    if (!content.endsWith(`</${documentTag}>`)) {
      if (
        !content.includes(`</${documentTag}>`) &&
        content.includes(`<${documentTag}>`)
      ) {
        content += `\n</${documentTag}>`;
      } else {
        content = content.replace(new RegExp(`</${documentTag}>.*$`, 's'), '');
        if (content.includes(`<${documentTag}>`)) {
          content += `\n</${documentTag}>`;
        }
      }
    }
    await this.writeOutputFile(filePath, content);
  }
}
