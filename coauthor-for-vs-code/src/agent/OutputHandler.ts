// Standard library imports
import * as path from 'path';

// Third-party imports
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/fileUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
} from '../utils/replacementUtils';
import {
  filterTagsFromText,
  addCdataToTags,
  addCdataToTagsMultiple,
} from '../utils/xmlUtils';
import {
  runLatexDiff,
  runLatexDiffForRound,
  runLatexDiffBetweenRounds,
} from '../latex/latexdiff';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSettings } from './AgentDataclass';

const CHANNEL = 'Agent';
logger.initializeLogging(CHANNEL);

export function getOutputFileName(
  inputFile: string,
  agent: string,
  model: string,
  outputExt: string,
  currRound: number,
  editedFile?: string,
): string {
  const { dir, name: fileName } = path.parse(inputFile);
  const agentFirstNameChunk = agent.split('_')[0];

  let newRound = currRound;
  if (editedFile) {
    const match = editedFile.match(/_r(\d+)_/);
    const editedRound = match ? parseInt(match[1]) : 0;
    newRound += editedRound + 1;
  }

  const outputBaseName = `${fileName}_${agentFirstNameChunk}_r${newRound}_${model}.${outputExt}`;
  const outputFile = path.join(dir, outputBaseName);
  logger.debug(CHANNEL, `Output file: ${outputFile}`);
  return outputFile;
}

export class OutputHandler {
  public agentSettings: AgentSettings;
  public agentConfig: AgentConfig;
  public modelHandler: any;
  public logId: number;
  public outputFiles: { [key: number]: string[] };
  public baseFiles: string[];

  constructor(
    agentSettings: AgentSettings,
    agentConfig: AgentConfig,
    modelHandler: any,
    logId: number,
  ) {
    this.agentSettings = agentSettings;
    this.agentConfig = agentConfig;
    this.modelHandler = modelHandler;
    this.logId = logId;
    this.outputFiles = { 0: [], 1: [] };
    this.baseFiles = [];
  }

  public async processXmlContent(outputContent: string): Promise<string> {
    outputContent = filterTagsFromText(outputContent, 'monologue');
    outputContent = applyReplacements(
      outputContent,
      getReplacementsByCategory('latex_xml'),
    );
    outputContent = applyReplacements(
      outputContent,
      getReplacementsByCategory('scratchpad_xml'),
    );
    return outputContent;
  }

  public extractDocumentContent(root: any, documentTag: string): string | null {
    const latexDocument = root.find(documentTag);
    if (latexDocument) {
      return latexDocument.content.trim();
    }
    logger.error(CHANNEL, `No ${documentTag} found in output file`);
    return null;
  }

  public async handleScratchpad(
    root: any,
    baseName: string,
    thinkingTag: string,
    splitAndSaveThinking: boolean,
  ): Promise<void> {
    if (splitAndSaveThinking) {
      const logFileThinking = `${baseName}_thinking.xml`;
      logger.debug(CHANNEL, `Thinking file: ${logFileThinking}`);
      const scratchpad = root.find(thinkingTag);
      if (scratchpad) {
        const scratchpadContent = scratchpad.content.trim();
        await writeFile(
          logFileThinking,
          `<scratchpad>\n${scratchpadContent}\n</scratchpad>\n`,
        );
      }
    }
  }

  public async handleSingleOutput(outputFile: string): Promise<void> {
    if (
      this.agentConfig.inputFile.includes('.tex') &&
      outputFile.includes('.tex')
    ) {
      await runLatexDiff(this.agentConfig.inputFile, outputFile);
    }
  }

  public async handleMultipleOutputs(outputFiles: string[]): Promise<void> {
    logger.debug(
      CHANNEL,
      `Handling multiple outputs: tasked outputFiles: ${this.agentConfig.outputFiles}; actual outputFiles: ${outputFiles}`,
    );
    if (this.agentConfig.outputFiles) {
      for (let i = 0; i < this.agentConfig.outputFiles.length; i++) {
        const inputFile = this.agentConfig.outputFiles[i];
        const outputFile = outputFiles[i];
        // TODO: Implement log update
        // await updateLogOutputFiles(this.logId, outputFile);
        if (inputFile.includes('.tex') && outputFile.includes('.tex')) {
          await runLatexDiff(inputFile, outputFile);
        }
      }
    }
  }

  public async processSingleOutput(outputFile: string): Promise<string> {
    const processedOutputFile = await this.splitScratchpadOutputXml(
      outputFile,
      this.agentSettings.documentTag,
    );
    const content = await readFile(processedOutputFile);
    const filteredContent = filterTagsFromText(content, 'monologue');
    await writeFile(processedOutputFile, filteredContent);
    return processedOutputFile;
  }

  public async processMultipleOutputs(outputFile: string): Promise<string[]> {
    const processedOutputFiles = await this.splitMultipleScratchpadOutputXml(
      outputFile,
      this.agentSettings.documentTag,
    );
    for (const processedOutputFile of processedOutputFiles) {
      const content = await readFile(processedOutputFile);
      const filteredContent = filterTagsFromText(content, 'monologue');
      await writeFile(processedOutputFile, filteredContent);
    }
    return processedOutputFiles;
  }

  async splitScratchpadOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
    splitAndSaveThinking: boolean = false,
  ): Promise<string> {
    logger.debug(CHANNEL, `Splitting scratchpad output XML: ${outputFile}`);

    const { dir, name, ext } = path.parse(outputFile);
    const texFile = path.join(dir, `${name}.tex`);
    logger.debug(CHANNEL, `TeX file: ${texFile}`);

    let outputContent = await readFile(outputFile);
    outputContent = await this.processXmlContent(outputContent);

    const tagsToWrap = [documentTag, thinkingTag];
    outputContent = addCdataToTags(outputContent, tagsToWrap);

    const rootContent = `<root>${outputContent}</root>`;

    try {
      const parser = new XMLParser({
        ignoreAttributes: true,
        preserveOrder: true,
        parseTagValue: false,
        textNodeName: 'content',
      });
      const root = parser.parse(rootContent);

      await this.handleScratchpad(
        root,
        name,
        thinkingTag,
        splitAndSaveThinking,
      );

      const latexDocument = this.extractDocumentContent(root, documentTag);
      if (latexDocument) {
        await writeFile(texFile, latexDocument);
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return texFile;
  }

  async splitMultipleScratchpadOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
    splitAndSaveThinking: boolean = false,
  ): Promise<string[]> {
    logger.debug(
      CHANNEL,
      `Splitting multiple scratchpad output XML: ${outputFile}`,
    );
    const { dir, name } = path.parse(outputFile);

    let outputContent = await readFile(outputFile);
    outputContent = await this.processXmlContent(outputContent);

    const tagsToWrap = [thinkingTag, 'document'];
    outputContent = addCdataToTagsMultiple(outputContent, tagsToWrap);

    const rootContent = `<root>${outputContent}</root>`;

    try {
      const parser = new XMLParser({
        ignoreAttributes: true,
        preserveOrder: true,
        parseTagValue: false,
        textNodeName: 'content',
      });
      const root = parser.parse(rootContent);
      logger.debug(CHANNEL, `Root: ${JSON.stringify(root)}`);
      logger.debug(CHANNEL, `root.root: ${JSON.stringify(root.root)}`);

      await this.handleScratchpad(
        root,
        name,
        thinkingTag,
        splitAndSaveThinking,
      );

      const latexDocuments = root.root[documentTag];
      if (latexDocuments) {
        return this.processLatexDocuments(latexDocuments, outputFile);
      }

      logger.error(CHANNEL, `No ${documentTag} found in output file.`);
      return [];
    } catch (err) {
      logger.error(
        CHANNEL,
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  public async processLatexDocuments(
    latexDocuments: any,
    outputFile: string,
  ): Promise<string[]> {
    const outputFiles: string[] = [];
    const outputParts = path.basename(outputFile).split('_');
    const agent = outputParts[outputParts.length - 3];
    const model = outputParts[outputParts.length - 1].split('.')[0];

    const roundMatch = outputFile.match(/_r(\d+)_/);
    const currRound = roundMatch ? parseInt(roundMatch[1]) : 0;

    for (const doc of latexDocuments) {
      const source = doc.name;
      logger.debug(CHANNEL, `XML Source: ${source}`);
      const content = doc.content;

      if (source && content) {
        const { name: baseName, ext } = path.parse(source);
        const extension = ext.replace('.', '');
        const texFile = getOutputFileName(
          baseName,
          agent,
          model,
          extension,
          currRound,
        );
        await writeFile(texFile, content.trim());
        outputFiles.push(texFile);
        logger.debug(CHANNEL, `TeX file written: ${texFile}`);
      } else {
        logger.error(
          CHANNEL,
          `Invalid document structure in ${latexDocuments.tag}`,
        );
      }
    }

    return outputFiles;
  }

  async ensureCorrectXmlStructure(
    filePath: string,
    documentTag: string,
  ): Promise<void> {
    logger.debug(CHANNEL, `Ensuring correct XML structure: ${filePath}`);
    let content = await readFile(filePath);

    if (
      content.startsWith('<scratchpad>') ||
      content.startsWith('<rebuttal_package>')
    ) {
      if (!content.endsWith(`</${documentTag}>`)) {
        if (
          !content.includes(`</${documentTag}>`) &&
          content.includes(`<${documentTag}>`)
        ) {
          content += `\n</${documentTag}>`;
        } else {
          content = content.replace(
            new RegExp(`</${documentTag}>.*$`, 's'),
            '',
          );
          if (content.includes(`<${documentTag}>`)) {
            content += `\n<${documentTag}>`;
          }
        }
      }

      content = await this.processXmlContent(content);
    }

    await writeFile(filePath, content);
  }

  public async handleLatexDiff(currRound: number): Promise<void> {
    logger.info(
      CHANNEL,
      `Running latexdiff for ${this.agentConfig.agent} round ${currRound}`,
    );
    logger.debug(CHANNEL, `Base files: ${this.baseFiles}`);
    logger.debug(
      CHANNEL,
      `Round ${currRound} output files: ${this.outputFiles[currRound]}`,
    );

    // Generate diffs between base files and current round
    for (let i = 0; i < this.baseFiles.length; i++) {
      const baseFile = this.baseFiles[i];
      const outputFile = this.outputFiles[currRound][i];
      await runLatexDiffForRound(baseFile, outputFile, currRound);
    }

    // Generate diffs between consecutive rounds
    for (let r = 1; r <= currRound; r++) {
      for (let i = 0; i < this.outputFiles[r - 1].length; i++) {
        const outputFile1 = this.outputFiles[r - 1][i];
        const outputFile2 = this.outputFiles[r][i];
        await runLatexDiffBetweenRounds(outputFile1, outputFile2);
      }
    }
  }

  public async replaceInputCommands(
    baseFiles: string[],
    outputFiles: string[],
  ): Promise<void> {
    if (!baseFiles?.length || !outputFiles?.length) {
      logger.debug(CHANNEL, 'No files to process for input command replacement');
      return;
    }

    const baseToOutput = new Map(
      baseFiles.map((bf, i) => [
        path.basename(bf),
        path.basename(outputFiles[i]),
      ]),
    );

    for (const outputFile of outputFiles) {
      if (!outputFile) continue;
      const content = await readFile(outputFile);
      const newContent = content.replace(/\\input{([^}]+)}/g, (match, p1) =>
        baseToOutput.has(p1) ? `\\input{${baseToOutput.get(p1)}}` : match,
      );

      if (newContent !== content) {
        await writeFile(outputFile, newContent);
        logger.debug(CHANNEL, `Updated input commands in ${outputFile}`);
      }
    }
  }
}
