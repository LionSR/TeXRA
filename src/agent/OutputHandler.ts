// Standard library imports
import * as path from 'path';

// Third-party imports
import { XMLParser } from 'fast-xml-parser';

// Local imports - log
import { AgentLogger } from '../logger/AgentLogger';

// Local imports - utilities
import { readFile, writeFile, fileExists } from '../utils/workspaceFileUtils';
import {
  addCdataToTags,
  addCdataToTagsMultiple,
  extractContentFromXMLbyTag,
  extractTextFromTag,
  extractContentFromXMLbyTagMultiple,
  extractMultipleTextFromTag,
} from '../utils/xmlUtils';
import {
  applyReplacements,
  getReplacementsByCategory,
  getAllReplacements,
} from '../replacement/replacementUtils';
import {
  runLatexdiff,
  runLatexdiffForRound,
  runLatexdiffBetweenRounds,
  LaTeXdiffResult,
} from '../latex/latexdiff';
import { checkToolInstalled } from '../latex/texTools';
import { runLatexIndent } from '../latex/latexindent';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSetting } from './AgentDataclass';
import { AgentStateGlobal, AgentStateRound } from './AgentState';

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
  public processGroupId?: string;
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

  /**
   * Starts a processing group for output handling.
   * Creates a log group at the same level as ResponseCycle.
   * @param processName Name of the processing operation
   * @param roundGroupId Parent round group ID
   * @returns The created process group ID
   */
  async startProcessing(
    processName: string,
    roundGroupId?: string,
  ): Promise<string> {
    // Create a log group as a child of the round group if provided
    const groupName = `OutputHandler: ${processName}`;
    const groupId = await this.logger.startGroup(
      groupName,
      undefined,
      roundGroupId,
    );
    // Comment out this line as it creates confusing log order
    // this.logger.info(`Starting ${processName}`, groupId);
    return groupId;
  }

  /**
   * Ends the current processing group.
   * @param status Status of the processing (error or stopped)
   */
  endProcessing(
    status: 'error' | 'stopped' = 'stopped',
    groupId?: string,
  ): void {
    if (groupId) {
      this.logger.endGroup(groupId, status);
    } else if (this.processGroupId) {
      // this.logger.info(`Completed output processing`, this.processGroupId);
      this.logger.endGroup(this.processGroupId, status);
      this.processGroupId = undefined;
    }
  }

  /**
   * Indents a LaTeX file for better readability
   */
  public async indentLatexFile(filePath: string): Promise<void> {
    if (!filePath.includes('.tex')) {
      return;
    }
    this.logger.debug(`Running latexindent on ${filePath}`);
    await runLatexIndent(filePath);
  }

  /**
   * Indents multiple LaTeX files for better readability
   */
  public async indentLatexFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.indentLatexFile(filePath);
    }
  }

  /** Processes XML content by filtering tags and applying replacements. */
  public async processXmlContent(content: string): Promise<string> {
    content = applyReplacements(content, getAllReplacements()).trim();

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

  /**
   * Helper method to log latexdiff results with appropriate level
   * @param result The result of a latexdiff operation
   * @param operation Description of the operation being performed
   * @param groupId The group ID for logging context
   */
  private logLatexdiffResult(
    result: LaTeXdiffResult,
    operation: string = 'latexdiff',
    groupId?: string,
  ): void {
    if (result.success) {
      this.logger.info(
        `Successfully generated ${operation} file: ${result.diffFileName}`,
        groupId,
      );
    } else {
      this.logger.warn(
        `Failed to generate ${operation}: ${result.message}`,
        groupId,
      );
    }
  }

  /**
   * Creates a mapping between two sets of files based on name similarity
   * @param sourceFiles Source files array
   * @param targetFiles Target files array
   * @param matchStrategy 'basename' for exact basename matching or 'contains' for substring matching
   * @param roundAware If true, ignores round numbers in filenames for matching
   * @returns Map of source files to their best matching target files
   * @private
   */
  public createFileMapping(
    sourceFiles: string[],
    targetFiles: string[],
    matchStrategy: 'basename' | 'contains' = 'basename',
    roundAware: boolean = false,
  ): Map<string, string> {
    const fileMapping = new Map<string, string>();

    if (!sourceFiles?.length || !targetFiles?.length) {
      return fileMapping;
    }

    for (const targetFile of targetFiles) {
      if (!targetFile) {
        continue;
      }

      const targetBaseName = path.basename(targetFile);

      // Find the best matching source file for this target file
      let bestMatch: string | null = null;
      let bestMatchScore = 0;

      for (const sourceFile of sourceFiles) {
        if (!sourceFile) {
          continue;
        }

        const sourceBaseName = path.basename(sourceFile);

        // Extract the main filename without extension for comparison
        const sourceName = path.parse(sourceBaseName).name;
        const targetName = path.parse(targetBaseName).name;

        // Handle round-aware matching if needed
        const sourceNameNormalized = roundAware
          ? sourceName.split('_r')[0]
          : sourceName;
        const targetNameNormalized = roundAware
          ? targetName.split('_r')[0]
          : targetName;

        let isMatch = false;
        let matchScore = 0;

        if (matchStrategy === 'basename') {
          // For exact basename matching
          isMatch = sourceNameNormalized === targetNameNormalized;
          matchScore = isMatch ? sourceNameNormalized.length : 0;
        } else if (matchStrategy === 'contains') {
          // For substring matching
          isMatch = targetBaseName.includes(sourceName);
          matchScore = isMatch ? sourceName.length : 0;
        }

        if (isMatch && matchScore > bestMatchScore) {
          bestMatchScore = matchScore;
          bestMatch = sourceFile;
        }
      }

      // If we found a match, add it to our map
      if (bestMatch) {
        fileMapping.set(bestMatch, targetFile);
      }
    }

    return fileMapping;
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

    // Create a mapping between base files and output files
    const baseToOutputMap = this.createFileMapping(
      baseFiles,
      outputFiles,
      'contains',
    );

    if (baseToOutputMap.size === 0) {
      this.logger.debug('No valid file mappings for input command replacement');
      return;
    }

    this.logger.debug(
      `File mappings for input replacement: ${Array.from(
        baseToOutputMap.entries(),
      )
        .map(
          ([base, output]) =>
            `${path.basename(base)} -> ${path.basename(output)}`,
        )
        .join(', ')}`,
    );

    // Create a map for basename lookups
    const baseToOutput = new Map<string, string>();
    for (const [baseFile, outputFile] of baseToOutputMap.entries()) {
      baseToOutput.set(path.basename(baseFile), path.basename(outputFile));
    }

    for (const outputFile of outputFiles) {
      if (!outputFile) {
        continue;
      }

      try {
        const content = await readFile(outputFile);
        // Replace \input commands with references to the new file paths
        const newContent = content.replace(/\\input{([^}]+)}/g, (match, p1) =>
          baseToOutput.has(p1) ? `\\input{${baseToOutput.get(p1)}}` : match,
        );

        if (newContent !== content) {
          await writeFile(outputFile, newContent);
          this.logger.debug(`Updated input commands in ${outputFile}`);
        }
      } catch (err) {
        this.logger.warn(
          `Error processing input commands in ${outputFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Runs all latexdiff comparisons for the current round.
   * This is the ONLY place where latexdiff operations should be performed.
   *
   * Generates two types of diffs:
   * 1. Round diffs: Between original input and current output (when in rewrite mode)
   * 2. Between-rounds diffs: Comparing previous round to current round (when applicable)
   *
   */
  public async handleLatexdiffofOutput(
    currRound: number,
    parentGroupId?: string,
  ): Promise<void> {
    // Create a dedicated log group for latexdiff operations FIRST
    const diffProcessGroupId = await this.startProcessing(
      `LatexDiff`,
      parentGroupId,
    );

    try {
      // Check if latexdiff is installed before proceeding
      if (!(await checkToolInstalled('latexdiff'))) {
        this.logger.warn(
          'Skipping latexdiff operations - latexdiff not installed',
          diffProcessGroupId,
        );
        this.endProcessing('stopped', diffProcessGroupId);
        return;
      }

      // Ensure we have output files for the current round
      const outputFiles = this.outputFiles[currRound] || [];
      if (outputFiles.length === 0) {
        this.logger.warn(
          `No output files found for round ${currRound}, skipping latexdiff operations`,
          diffProcessGroupId,
        );
        this.endProcessing('stopped', diffProcessGroupId);
        return;
      }

      // Log debugging information within the group
      this.logger.debug(`Base files: ${this.baseFiles}`, diffProcessGroupId);
      this.logger.debug(
        `Round ${currRound} output files: ${outputFiles}`,
        diffProcessGroupId,
      );

      // Create a mapping between base files and output files
      const baseToOutputMap = this.createFileMapping(
        this.baseFiles,
        outputFiles,
        'contains',
      );

      this.logger.debug(
        `Matched base files to output files: ${Array.from(
          baseToOutputMap.entries(),
        )
          .map(
            ([base, output]) =>
              `${path.basename(base)} -> ${path.basename(output)}`,
          )
          .join(', ')}`,
        diffProcessGroupId,
      );

      // 1. ROUND DIFFS: Comparing original input to current output (only in rewrite mode)
      if (this.agentSetting.isRewrite) {
        this.logger.debug(
          `Running round-based latexdiff operations`,
          diffProcessGroupId,
        );

        // Generate diffs based on our matched file pairs
        for (const [baseFile, outputFile] of baseToOutputMap.entries()) {
          // Call latexdiff specialized for rounds
          const result = await runLatexdiffForRound(
            baseFile,
            outputFile,
            currRound,
          );

          this.logLatexdiffResult(result, 'round-diff', diffProcessGroupId);
        }
      }

      // 2. SEQUENTIAL ROUND DIFFS: Comparing previous round to current round
      if (currRound > 0) {
        this.logger.debug(
          `Running between-rounds latexdiff operations`,
          diffProcessGroupId,
        );

        const prevOutputFiles = this.outputFiles[currRound - 1] || [];

        // Create a mapping between previous round files and current round files
        const prevToCurrentMap = this.createFileMapping(
          prevOutputFiles,
          outputFiles,
          'basename',
          true, // Enable round-aware matching
        );

        this.logger.debug(
          `Matched previous round files to current round files: ${Array.from(
            prevToCurrentMap.entries(),
          )
            .map(
              ([prev, curr]) =>
                `${path.basename(prev)} -> ${path.basename(curr)}`,
            )
            .join(', ')}`,
          diffProcessGroupId,
        );

        // Generate diffs based on our matched file pairs between rounds
        for (const [
          prevOutputFile,
          currOutputFile,
        ] of prevToCurrentMap.entries()) {
          // Call latexdiff specialized for between-rounds
          const result = await runLatexdiffBetweenRounds(
            prevOutputFile,
            currOutputFile,
          );

          this.logLatexdiffResult(
            result,
            'between-rounds-diff',
            diffProcessGroupId,
          );
        }
      }

      this.endProcessing('stopped', diffProcessGroupId);
    } catch (err) {
      this.logger.error(
        `Error during latexdiff processing: ${err instanceof Error ? err.message : String(err)}`,
        diffProcessGroupId,
      );
      this.endProcessing('error', diffProcessGroupId);
    }
  }

  /** Processes single output file with XML splitting and filtering. */
  public async processSingleXmlOutput(outputFile: string): Promise<string> {
    this.logger.debug(`Splitting scratchpad output XML: ${outputFile}`);
    const processedOutputFile = await this.splitScratchpadOutputXml(
      outputFile,
      this.agentSetting.documentTag,
    );
    const content = await readFile(processedOutputFile);
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
    return processedOutputFiles;
  }

  /**
   * Fallback extraction for single document case using regex when XML parsing fails
   * @private
   */
  private extractDocumentbyRegex(
    outputContent: string,
    documentTag: string,
  ): string | null {
    try {
      const fallbackContent = extractTextFromTag(outputContent, documentTag);
      if (fallbackContent) {
        this.logger.info(
          `Successfully extracted ${documentTag} using fallback method`,
        );
        return fallbackContent;
      }
      this.logger.error(
        `No ${documentTag} found in output file using fallback method`,
      );
      return null;
    } catch (fallbackErr) {
      this.logger.error(
        `Failed fallback extraction: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
      );
      return null;
    }
  }

  /**
   * Fallback extraction for multiple documents case using regex when XML parsing fails
   * @private
   */
  private extractMultipleDocumentsbyRegex(
    outputContent: string,
    documentTag: string,
  ): Array<{ content: string; name: string }> | null {
    try {
      const fallbackDocuments = extractMultipleTextFromTag(
        outputContent,
        documentTag,
      );

      if (fallbackDocuments.length > 0) {
        this.logger.info(
          `Successfully extracted ${fallbackDocuments.length} documents using fallback method`,
        );
        return fallbackDocuments;
      }

      this.logger.error(
        `No documents found in output file using fallback method`,
      );
      return null;
    } catch (fallbackErr) {
      this.logger.error(
        `Failed fallback extraction: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
      );
      return null;
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

      const latexDocument = extractContentFromXMLbyTag(root, documentTag);
      if (latexDocument) {
        await writeFile(texFile, latexDocument);
        return texFile;
      } else {
        this.logger.warn(
          `No ${documentTag} found in parsed XML, attempting fallback extraction...`,
        );
        // Try fallback extraction using regex method
        const fallbackContent = this.extractDocumentbyRegex(
          outputContent,
          documentTag,
        );
        if (fallbackContent) {
          await writeFile(texFile, fallbackContent);
          return texFile;
        }
        return texFile;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}, attempting fallback extraction...`,
      );
      // Try fallback extraction if XML parsing fails
      const fallbackContent = this.extractDocumentbyRegex(
        outputContent,
        documentTag,
      );
      if (fallbackContent) {
        await writeFile(texFile, fallbackContent);
        return texFile;
      }
      // Re-throw the original error if fallback also failed
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

      const documents = extractContentFromXMLbyTagMultiple(root, documentTag);
      if (documents) {
        return this.processMultipleLatexDocuments(documents, outputFile);
      } else {
        this.logger.warn(
          `No ${documentTag} found in parsed XML, attempting fallback extraction...`,
        );
        // Try fallback extraction using regex for the document container
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
      }
    } catch (err) {
      this.logger.warn(
        `Failed to parse XML content: ${err instanceof Error ? err.message : String(err)}, attempting fallback extraction...`,
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
      // Re-throw the original error if fallback also failed
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
    const agent = outputParts.at(-3) ?? '';
    const model = outputParts.at(-1)?.split('.')[0] ?? '';

    const roundMatch = outputFile.match(/_r(\d+)_/);
    const currRound = roundMatch ? parseInt(roundMatch[1]) : 0;

    for (const doc of latexDocuments) {
      // Skip documents with empty/undefined name or content
      if (!doc.name || doc.name === 'unknown' || !doc.content) {
        this.logger.warn(`Skipping document with empty name or content`);
        continue;
      }

      const source = doc.name.trim();
      // Skip if source is empty after trimming
      if (!source) {
        this.logger.warn(
          `Skipping document with empty source name after trimming`,
        );
        continue;
      }

      this.logger.debug(`XML Source: ${source}`);

      const { ext } = path.parse(source);
      const extension = ext.replace('.', '') || 'tex';
      const texFile = getOutputFileName(
        source,
        agent,
        model,
        extension,
        currRound,
      );
      await writeFile(texFile, doc.content.trim());
      outputFiles.push(texFile);
      this.logger.debug(`TeX file written: ${texFile}`);
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

  /** Prints statistics about token usage and costs */
  public async printStatistics(
    stateGlobal: AgentStateGlobal,
    parentGroupId?: string,
  ): Promise<void> {
    // Create a dedicated log group for statistics
    const statsGroupId = await this.startProcessing(
      'Statistics',
      parentGroupId,
    );

    try {
      this.logger.info('=== Task Statistics ===', statsGroupId);

      // Token usage statistics
      this.logger.info(
        `Total input tokens  : ${stateGlobal.totalInputTokens}`,
        statsGroupId,
      );
      this.logger.info(
        `Total output tokens : ${stateGlobal.totalOutputTokens}`,
        statsGroupId,
      );

      // Calculate caching statistics if model supports either type of caching
      if (
        this.modelHandler.capabilities.supportsPromptCaching ||
        this.modelHandler.capabilities.supportsAutoPromptCaching
      ) {
        this.logger.info(
          `Total input tokens (cache read): ${stateGlobal.totalCacheReadInputTokens}`,
          statsGroupId,
        );

        // Only show cache creation for Anthropic models (which use explicit caching)
        if (this.modelHandler.capabilities.supportsPromptCaching) {
          this.logger.info(
            `Total input tokens (cache create): ${stateGlobal.totalCacheCreationInputTokens}`,
            statsGroupId,
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
            ? (stateGlobal.totalCacheReadInputTokens / totalCacheableTokens) *
              100
            : 0;
        this.logger.info(
          `Percentage cached: ${percentageCached.toFixed(2)}%`,
          statsGroupId,
        );
      }

      // Print reasoning tokens if model supports it
      if (this.modelHandler.capabilities.supportsReasoning) {
        this.logger.info(
          `Total reasoning tokens: ${stateGlobal.totalReasoningTokens}`,
          statsGroupId,
        );
      }

      if (stateGlobal.totalToolUseTokens > 0) {
        this.logger.info(
          `Total tool use tokens: ${stateGlobal.totalToolUseTokens}`,
          statsGroupId,
        );
      }

      // Format token usage reporting by model provider
      let responseUsage: any = {};
      if (this.modelHandler.isOpenai) {
        if (this.modelHandler.capabilities.supportsAutoPromptCaching) {
          responseUsage = {
            prompt_tokens: stateGlobal.totalInputTokens,
            completion_tokens: stateGlobal.totalOutputTokens,
            // Note: OpenAI doesn't provide tool_use_tokens in their API
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
            // Note: OpenAI doesn't provide tool_use_tokens in their API
            reasoning_tokens: stateGlobal.totalReasoningTokens,
            cached_tokens: stateGlobal.totalCacheReadInputTokens,
          };
        }
      } else if (this.modelHandler.isAnthropic) {
        responseUsage = {
          input_tokens: stateGlobal.totalInputTokens,
          output_tokens: stateGlobal.totalOutputTokens,
          // Note: Anthropic doesn't provide tool_use_tokens in their API
          cache_read_input_tokens: stateGlobal.totalCacheReadInputTokens,
          cache_creation_input_tokens:
            stateGlobal.totalCacheCreationInputTokens,
        };
      } else if (this.modelHandler.isGoogle) {
        responseUsage = {
          promptTokens: stateGlobal.totalInputTokens,
          completionTokens: stateGlobal.totalOutputTokens,
          toolUseTokenCount: stateGlobal.totalToolUseTokens,
        };
      }

      const cost = this.modelHandler.computePrice(responseUsage);

      this.logger.info(
        `Total response time : ${stateGlobal.totalResponseTime.toFixed(1)} seconds`,
        statsGroupId,
      );
      this.logger.info(
        `Total cost          : ${cost.toFixed(3)} USD`,
        statsGroupId,
      );
      this.logger.info('=======================', statsGroupId);

      // End the statistics group
      this.endProcessing('stopped', statsGroupId);
    } catch (error) {
      this.logger.error(`Error printing statistics: ${error}`, statsGroupId);
      this.endProcessing('error', statsGroupId);
    }
  }
  /** Processes output files for current round. */
  protected async handleOutput(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    outputFile: string,
    endTurn: boolean,
    currRound: number = 0,
    roundGroupId?: string,
  ): Promise<string[]> {
    // Print statistics at the end of each round
    await this.printStatistics(stateGlobal, roundGroupId);

    return this.outputFiles[currRound] || [];
  }
}
