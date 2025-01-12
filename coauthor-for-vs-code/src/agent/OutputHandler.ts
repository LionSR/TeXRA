// Standard library imports
import * as path from 'path';

// Third-party imports
import { XMLParser } from 'fast-xml-parser';

// Local imports - log
import { AgentLogger } from '../logger/AgentLogger';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/fileUtils';
import {
  filterTagsFromText,
  addCdataToTags,
  addCdataToTagsMultiple,
  extractContentFromTag,
  extractTextFromTag,
  extractContentFromTagMultiple,
} from '../utils/xmlUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
} from '../utils/replacementUtils';
import {
  runLatexdiff,
  runLatexdiffForRound,
  runLatexdiffBetweenRounds,
  ensureLatexdiffInstalled,
} from '../latex/latexdiff';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting } from './AgentDataclass';
import { AgentStateGlobal } from './AgentState';

/** Generates output filename incorporating model and round information. */
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
  return outputFile;
}

/** Handles output file processing and validation for agent responses. */
export class OutputHandler {
  public agentSetting: AgentSetting;
  public agentConfig: AgentConfig;
  public modelHandler: any;
  public logId: number;
  public outputFiles: { [key: number]: string[] };
  public baseFiles: string[];
  protected logger: AgentLogger;
  protected channel: string;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    modelHandler: any,
    logId: number,
    baseFiles: string[] = [],
    logger?: AgentLogger,
  ) {
    this.agentSetting = agentSetting;
    this.agentConfig = agentConfig;
    this.modelHandler = modelHandler;
    this.logId = logId;
    this.outputFiles = { 0: [], 1: [] };
    this.baseFiles = baseFiles;
    this.logger = logger || new AgentLogger('OutputHandler');
    this.channel = this.logger.channelId;
  }

  /** Processes XML content by filtering tags and applying replacements. */
  public async processXmlContent(content: string): Promise<string> {
    if (this.agentConfig.toolConfig.autoConfirmation) {
      content = filterTagsFromText(content, 'monologue');
    }
    content = applyReplacements(
      content,
      getReplacementsByCategory('latex_xml'),
    );
    content = applyReplacements(
      content,
      getReplacementsByCategory('scratchpad_xml'),
    );
    return content;
  }

  /** Runs latexdiff on single output file. */
  public async handleSingleOutput(outputFile: string): Promise<void> {
    if (
      this.agentConfig.inputFile.includes('.tex') &&
      outputFile.includes('.tex')
    ) {
      // Check if latexdiff is installed before proceeding
      if (!(await ensureLatexdiffInstalled())) {
        this.logger.warn(
          'Skipping latexdiff operation - latexdiff not installed',
        );
        return;
      }

      this.logger.info(
        `Running latexdiff for ${this.agentConfig.inputFile} and ${outputFile}`,
      );
      await runLatexdiff(
        this.agentConfig.inputFile,
        outputFile,
        '_diff',
        false,
        this.channel,
      );
    }
  }

  /** Runs latexdiff on multiple output files. */
  public async handleMultipleOutputs(outputFiles: string[]): Promise<void> {
    this.logger.debug(
      `Handling multiple outputs: tasked outputFiles: ${this.agentConfig.outputFiles}; actual outputFiles: ${outputFiles}`,
    );
    if (
      Array.isArray(this.agentConfig.outputFiles) &&
      this.agentConfig.outputFiles.length > 0 &&
      Array.isArray(outputFiles) &&
      outputFiles.length > 0
    ) {
      // Check if latexdiff is installed before proceeding
      if (!(await ensureLatexdiffInstalled())) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
        );
        return;
      }

      this.logger.info(
        `Running latexdiff for ${this.agentConfig.outputFiles} and ${outputFiles}`,
      );
      for (let i = 0; i < this.agentConfig.outputFiles.length; i++) {
        const inputFile = this.agentConfig.outputFiles[i];
        const outputFile = outputFiles[i];
        // TODO: Implement log update
        // await updateLogOutputFiles(this.logId, outputFile);
        if (inputFile.includes('.tex') && outputFile.includes('.tex')) {
          await runLatexdiff(
            inputFile,
            outputFile,
            '_diff',
            false,
            this.channel,
          );
        }
      }
    }
  }

  /** Processes single output file with XML splitting and filtering. */
  public async processSingleXmlOutput(outputFile: string): Promise<string> {
    this.logger.debug(`Splitting scratchpad output XML: ${outputFile}`);
    const processedOutputFile = await this.splitScratchpadOutputXml(
      outputFile,
      this.agentSetting.documentTag,
    );
    let content = await readFile(processedOutputFile);
    if (this.agentConfig.toolConfig.autoConfirmation) {
      content = filterTagsFromText(content, 'monologue');
    }
    await writeFile(processedOutputFile, content);
    return processedOutputFile;
  }

  /** Processes multiple output files with XML splitting and filtering. */
  public async processMultipleXmlOutputs(
    outputFile: string,
  ): Promise<string[]> {
    this.logger.debug(
      `Splitting multiple scratchpad output XML: ${outputFile}`,
    );
    const processedOutputFiles = await this.splitScratchpadMultipleOutputXml(
      outputFile,
      this.agentSetting.documentTag,
    );
    if (this.agentConfig.toolConfig.autoConfirmation) {
      for (const processedOutputFile of processedOutputFiles) {
        let content = await readFile(processedOutputFile);
        content = filterTagsFromText(content, 'monologue');
        await writeFile(processedOutputFile, content);
      }
    }
    return processedOutputFiles;
  }

  /** Extracts and logs scratchpad content from output. */
  private extractAndLogScratchpad(
    outputContent: string,
    thinkingTag: string = 'scratchpad',
  ): void {
    const scratchpadContent = extractTextFromTag(outputContent, thinkingTag);
    if (scratchpadContent) {
      this.logger.info(`Scratchpad content:\n${scratchpadContent.trim()}`);
    }
  }

  /**
   * Splits XML output into separate files for document and scratchpad content.
   * Handles CDATA wrapping and XML parsing.
   */
  async splitScratchpadOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<string> {
    const { dir, name, ext } = path.parse(outputFile);
    const texFile = path.join(dir, `${name}.tex`);

    let outputContent = await readFile(outputFile);

    if (this.agentSetting.agentType === 'CoT') {
      this.extractAndLogScratchpad(outputContent, thinkingTag);
    }

    const tagsToWrap = [documentTag, thinkingTag];
    outputContent = addCdataToTags(outputContent, tagsToWrap);

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        // preserveOrder: true,
        parseTagValue: true,
        textNodeName: 'content',
        attributeNamePrefix: '',
      });
      const root = parser.parse(outputContent);

      const latexDocument = extractContentFromTag(root, documentTag);
      if (latexDocument) {
        await writeFile(texFile, latexDocument);
        return texFile;
      } else {
        this.logger.error(`No ${documentTag} found in output file`);
        return texFile;
      }
    } catch (err) {
      this.logger.error(
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Splits XML output containing multiple documents into separate files.
   * Handles CDATA wrapping and XML parsing for each document.
   */
  async splitScratchpadMultipleOutputXml(
    outputFile: string,
    documentTag: string,
    thinkingTag: string = 'scratchpad',
  ): Promise<string[]> {
    let outputContent = await readFile(outputFile);

    if (this.agentSetting.agentType === 'CoT') {
      this.extractAndLogScratchpad(outputContent, thinkingTag);
    }

    const tagsToWrap = [thinkingTag, 'document'];
    outputContent = addCdataToTagsMultiple(outputContent, tagsToWrap);

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        // preserveOrder: false,
        parseTagValue: true,
        textNodeName: 'content',
        attributeNamePrefix: '',
      });
      const root = parser.parse(outputContent);

      const documents = extractContentFromTagMultiple(root, documentTag);
      if (documents) {
        return this.processMultipleLatexDocuments(documents, outputFile);
      } else {
        this.logger.error(`No ${documentTag} found in output file`);
        return [];
      }
    } catch (err) {
      this.logger.error(
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /** Processes LaTeX documents into separate output files. */
  async processMultipleLatexDocuments(
    latexDocuments: Array<{ content: string; name: string }>,
    outputFile: string,
  ): Promise<string[]> {
    const outputFiles: string[] = [];
    const outputParts = path.basename(outputFile).split('_');
    const agent = outputParts.at(-3) || '';
    const model = outputParts.at(-1)?.split('.')[0] || '';

    const roundMatch = outputFile.match(/_r(\d+)_/);
    const currRound = roundMatch ? parseInt(roundMatch[1]) : 0;

    for (const doc of latexDocuments) {
      if (doc.name) {
        const source = doc.name;
        this.logger.debug(`XML Source: ${source}`);
        const content = doc.content;

        if (source && content) {
          const { ext } = path.parse(source);
          const extension = ext.replace('.', '') || 'tex';
          const texFile = getOutputFileName(
            source,
            agent,
            model,
            extension,
            currRound,
          );
          await writeFile(texFile, content.trim());
          outputFiles.push(texFile);
          this.logger.debug(`TeX file written: ${texFile}`);
        } else {
          this.logger.error(`Invalid document structure in document tag`);
        }
      }
    }

    return outputFiles;
  }

  /** Validates and fixes XML structure in output file. */
  // TODO: use XML.Validator in the future [this function is a bit outdated]
  async ensureCorrectXmlStructure(
    filePath: string,
    documentTag: string,
  ): Promise<void> {
    this.logger.debug(`Ensuring correct XML structure: ${filePath}`);
    let content = await readFile(filePath);

    content = await this.processXmlContent(content);

    // if (
    //   content.startsWith('<scratchpad>') ||
    //   content.startsWith('<rebuttal_package>')
    // ) {

    if (!content.endsWith(`</${documentTag}>`)) {
      if (
        !content.includes(`</${documentTag}>`) &&
        content.includes(`<${documentTag}>`)
      ) {
        content += `\n</${documentTag}>`;
      } else {
        content = content.replace(new RegExp(`</${documentTag}>.*$`, 's'), '');
        if (content.includes(`<${documentTag}>`)) {
          content += `\n<${documentTag}>`;
        }
      }
    }
    await writeFile(filePath, content);
  }

  /**
   * Runs latexdiff comparisons for current round.
   * Generates diffs between base files and current round, and between consecutive rounds.
   */
  public async handleLatexdiff(currRound: number): Promise<void> {
    // Check if latexdiff is installed before proceeding
    if (!(await ensureLatexdiffInstalled())) {
      this.logger.warn(
        'Skipping latexdiff operations - latexdiff not installed',
      );
      return;
    }

    this.logger.info(
      `Running latexdiff for ${this.agentConfig.agent} round ${currRound}`,
    );
    this.logger.debug(`Base files: ${this.baseFiles}`);
    this.logger.debug(
      `Round ${currRound} output files: ${this.outputFiles[currRound]}`,
    );

    // Generate diffs between base files and current round
    for (let i = 0; i < this.baseFiles.length; i++) {
      const baseFile = this.baseFiles[i];
      const outputFile = this.outputFiles[currRound][i];
      await runLatexdiffForRound(baseFile, outputFile, currRound, this.channel);
    }

    // Generate diffs between consecutive rounds
    for (let r = 1; r <= currRound; r++) {
      for (let i = 0; i < this.outputFiles[r - 1].length; i++) {
        const outputFile1 = this.outputFiles[r - 1][i];
        const outputFile2 = this.outputFiles[r][i];
        await runLatexdiffBetweenRounds(outputFile1, outputFile2, this.channel);
      }
    }
  }

  /** Updates \input commands in output files to reference new file paths. */
  public async replaceInputCommands(
    baseFiles: string[],
    outputFiles: string[],
  ): Promise<void> {
    if (!baseFiles?.length || !outputFiles?.length) {
      this.logger.debug('No files to process for input command replacement');
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
        this.logger.debug(`Updated input commands in ${outputFile}`);
      }
    }
  }

  /** Prints statistics about token usage and costs */
  public printStatistics(stateGlobal: AgentStateGlobal): void {
    this.logger.info('=== Task Statistics ===');
    this.logger.info(`Total input tokens  : ${stateGlobal.totalInputTokens}`);
    this.logger.info(`Total output tokens : ${stateGlobal.totalOutputTokens}`);

    // Calculate caching statistics if model supports either type of caching
    if (
      this.modelHandler.capabilities.supportsPromptCaching ||
      this.modelHandler.capabilities.supportsAutoPromptCaching
    ) {
      this.logger.info(
        `Total input tokens (cache read): ${stateGlobal.totalCacheReadInputTokens}`,
      );

      // Only show cache creation for Anthropic models (which use explicit caching)
      if (this.modelHandler.capabilities.supportsPromptCaching) {
        this.logger.info(
          `Total input tokens (cache create): ${stateGlobal.totalCacheCreationInputTokens}`,
        );
      }

      // Calculate percentage cached
      let totalCacheableTokens: number;
      if (this.modelHandler.capabilities.supportsPromptCaching) {
        // For Anthropic: include both read and creation tokens
        totalCacheableTokens =
          stateGlobal.totalCacheCreationInputTokens +
          stateGlobal.totalCacheReadInputTokens;
      } else {
        // For OpenAI auto-caching: only use input tokens as base
        totalCacheableTokens = stateGlobal.totalInputTokens;
      }

      const percentageCached =
        totalCacheableTokens > 0
          ? (stateGlobal.totalCacheReadInputTokens / totalCacheableTokens) * 100
          : 0;
      this.logger.info(`Percentage cached: ${percentageCached.toFixed(2)}%`);
    }

    // Print reasoning tokens if model supports it
    if (this.modelHandler.capabilities.supportsReasoning) {
      this.logger.info(
        `Total reasoning tokens: ${stateGlobal.totalReasoningTokens}`,
      );
    }

    // Calculate cost using model handler's price computation
    let responseUsage;
    if (this.modelHandler.isOpenai) {
      if (this.modelHandler.capabilities.supportsAutoPromptCaching) {
        responseUsage = {
          prompt_tokens: stateGlobal.totalInputTokens,
          completion_tokens: stateGlobal.totalOutputTokens,
          prompt_tokens_details: {
            cached_tokens: stateGlobal.totalCacheReadInputTokens,
          },
          completion_tokens_details: {
            reasoning_tokens: stateGlobal.totalReasoningTokens,
          },
        };
      } else {
        responseUsage = {
          prompt_tokens: stateGlobal.totalInputTokens,
          completion_tokens: stateGlobal.totalOutputTokens,
          reasoning_tokens: stateGlobal.totalReasoningTokens,
          cached_tokens: stateGlobal.totalCacheReadInputTokens,
        };
      }
    } else if (this.modelHandler.isAnthropic) {
      responseUsage = {
        input_tokens: stateGlobal.totalInputTokens,
        output_tokens: stateGlobal.totalOutputTokens,
        cache_read_input_tokens: stateGlobal.totalCacheReadInputTokens,
        cache_creation_input_tokens: stateGlobal.totalCacheCreationInputTokens,
      };
    } else if (this.modelHandler.isGoogle) {
      responseUsage = {
        promptTokens: stateGlobal.totalInputTokens,
        completionTokens: stateGlobal.totalOutputTokens,
      };
    }

    const cost = this.modelHandler.computePrice(responseUsage);

    this.logger.info(
      `Total response time : ${stateGlobal.totalResponseTime.toFixed(1)} seconds`,
    );
    this.logger.warn(`Total cost          : ${cost.toFixed(3)} USD`);
    this.logger.info('=======================');
  }
}
