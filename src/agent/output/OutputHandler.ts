// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { DiffStatsManager } from './DiffStatsManager';
import type { IOutputHandler } from './IOutputHandler';
import { LatexDiffManager } from './LatexDiffManager';
import type {
  NamedOutputFile,
  OutputFileInfo,
  RoundFileMapping,
} from './types';
import { XmlOutputManager } from './XmlOutputManager';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentType,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';

// Local imports - utilities
import { runLatexFormatter } from '@latex/texFormatter';

// Local imports - log
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Local imports - utilities
import { replaceInputCommands, createFileMapping } from '@utils/files';
import {
  WorkspaceFS,
  AbsoluteFS,
  TaskRunFileService,
  readFlexible,
} from '@utils/files';
import { getEffectiveBaseFile } from '@utils/files/baseFileUtils';
import {
  extractMultipleTextFromTag,
  extractTextFromTag,
} from '@utils/text/xmlUtils';

// Local imports - types

/** Handles output file processing and validation for agent responses. */
export class OutputHandler implements IOutputHandler {
  public agentSetting: AgentWorkflowSetting;
  public agentConfig: AgentConfig;
  public logId: number;
  public outputFiles: { [key: number]: string[] };
  public outputMappings: { [key: number]: NamedOutputFile[] };
  private rawOutputs: { [key: number]: string | null };
  private roundFileInfos: { [key: number]: OutputFileInfo[] };
  private roundMappings: { [key: number]: RoundFileMapping };
  private roundXmlSummaries: { [key: number]: OutputXmlSummary };
  public baseFiles: string[];
  protected logger: AgentLogger;
  protected channel: string;
  public readonly xmlManager: XmlOutputManager;
  public readonly diffManager: LatexDiffManager;
  private diffStatsManager: DiffStatsManager;
  private readonly openedOutputs: Set<string>;
  private readonly fileService: TaskRunFileService;
  private currentRunId: string | null;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    logId: number,
    baseFiles: string[] = [],
    logger?: AgentLogger,
    fileService?: TaskRunFileService,
  ) {
    this.agentSetting = requireWorkflowSetting(agentSetting);
    this.agentConfig = agentConfig;
    this.logId = logId;
    this.outputFiles = {};
    this.outputMappings = {};
    this.rawOutputs = {};
    this.roundFileInfos = {};
    this.roundMappings = {};
    this.roundXmlSummaries = {};
    this.baseFiles = baseFiles;
    this.logger = logger || new AgentLogger('OutputHandler');
    this.channel = this.logger.channelId;
    this.fileService = fileService || new TaskRunFileService();

    this.xmlManager = new XmlOutputManager(
      this.agentSetting,
      this.agentConfig,
      this.logger,
    );
    this.diffManager = new LatexDiffManager(
      this.agentSetting,
      this.outputFiles,
      this.baseFiles,
      this.logger,
      this.channel,
      this.fileService,
    );
    this.diffStatsManager = new DiffStatsManager();
    this.openedOutputs = new Set();
    this.currentRunId = null;
  }

  public setActiveRun(runId?: string | null): void {
    this.currentRunId = runId ?? null;
  }

  private async withOutputStage<T>(
    label: string,
    parentStage: AgentLogStage | undefined,
    fn: (stage: AgentLogStage) => Promise<T>,
  ): Promise<T> {
    const stage = await this.logger.stage(`Output: ${label}`, {
      parent: parentStage,
      skip: true,
    });
    return stage.run(() => fn(stage));
  }

  /**
   * Ensure that storage exists for a round and return its output list.
   * @param round The round index to initialize.
   * @returns The mutable list of outputs for the round.
   */
  public ensureRound(round: number): string[] {
    if (!this.outputFiles[round]) {
      this.outputFiles[round] = [];
    }
    if (!this.outputMappings[round]) {
      this.outputMappings[round] = [];
    }
    if (!this.roundFileInfos[round]) {
      this.roundFileInfos[round] = [];
    }
    if (!Object.prototype.hasOwnProperty.call(this.rawOutputs, round)) {
      this.rawOutputs[round] = null;
    }
    return this.outputFiles[round];
  }

  /**
   * Check if a round has any generated outputs.
   * @param round The round index to inspect.
   * @returns True when the round has at least one output.
   */
  public hasRoundOutputs(round: number): boolean {
    const outputs = this.outputFiles[round];
    return Array.isArray(outputs) && outputs.length > 0;
  }

  /**
   * Indents a LaTeX file for better readability
   */
  public async indentLatexFile(filePath: string): Promise<void> {
    if (!filePath.includes('.tex')) {
      return;
    }
    this.logger.debug(`Formatting ${filePath}`);
    await runLatexFormatter(filePath);
  }

  /**
   * Indents multiple LaTeX files for better readability
   */
  public async indentLatexFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.indentLatexFile(filePath);
    }
  }

  private async cleanupLatexBackups(
    originalPath?: string | null,
  ): Promise<void> {
    if (!originalPath) {
      return;
    }

    const workspaceRoot = WorkspaceFS.getPath();
    if (!workspaceRoot) {
      return;
    }

    const absolutePath = path.isAbsolute(originalPath)
      ? originalPath
      : path.join(workspaceRoot, originalPath);

    if (!absolutePath.startsWith(workspaceRoot)) {
      return;
    }

    const { dir, base, name } = path.parse(absolutePath);
    const backupCandidates = new Set<string>([
      path.join(dir, `${base}.bak`),
      path.join(dir, `${base}.bak0`),
      path.join(dir, `${base}.bak1`),
      path.join(dir, `${name}.bak`),
      path.join(dir, `${name}.bak0`),
      path.join(dir, `${name}.bak1`),
    ]);

    for (const candidate of backupCandidates) {
      const relative = path.relative(workspaceRoot, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        continue;
      }

      try {
        if (await WorkspaceFS.exists(relative)) {
          await WorkspaceFS.delete(relative);
          this.logger.debug(`Removed latexindent backup ${relative}`);
        }
      } catch (error) {
        this.logger.debug(
          `Failed to remove latexindent backup ${relative}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Gather mapping and diff statistics for output files of a round.
   */
  public async gatherOutputFileInfo(
    currRound: number,
  ): Promise<OutputFileInfo[]> {
    const roundOutputs = this.ensureRound(currRound);
    const mapping = this.getRoundMapping(currRound);

    const infos: OutputFileInfo[] = [];
    const namedByStorage = new Map(
      this.getNamedOutputs(currRound).map((entry) => [entry.path, entry]),
    );

    for (const file of roundOutputs) {
      const named = namedByStorage.get(file);
      const relativeKey = named
        ? (named.relativePath ?? named.path)
        : this.fileService.getWorkspaceDisplayPath(file);

      const baseEntry = Array.from(mapping.baseToOutput.entries()).find(
        ([, out]) => out === relativeKey,
      );
      const prevEntry = Array.from(mapping.prevToOutput.entries()).find(
        ([, out]) => out === relativeKey,
      );
      const baseFile = baseEntry ? baseEntry[0] : null;
      const prevFile = prevEntry ? prevEntry[0] : null;
      const originalFile = mapping.originByOutput.get(relativeKey) || null;

      const diffBaseRelative = getEffectiveBaseFile(
        baseFile,
        originalFile,
        relativeKey,
      );
      const diffBaseActual = diffBaseRelative
        ? this.fileService.resolveRelativePath(diffBaseRelative, {
            preferWorkspace: true,
          }).actual
        : null;
      const stats = await this.diffStatsManager.computeDiffStats(
        diffBaseActual,
        file,
      );

      const workspacePath =
        named?.workspacePath ??
        mapping.workspaceByOutput.get(relativeKey) ??
        null;

      const relativePath = relativeKey;
      const displayLabel = this.fileService.getDisplayLabel(
        baseFile ?? relativePath,
      );
      const displayDirSource = baseFile ?? relativePath;
      const displayDirRaw = displayDirSource
        ? path.dirname(displayDirSource)
        : '';
      const displayDir =
        !displayDirRaw || displayDirRaw === '.' ? '' : displayDirRaw;

      infos.push({
        path: file,
        relativePath,
        displayLabel,
        displayDir,
        workspacePath: workspacePath ?? null,
        base: baseFile,
        prev: prevFile,
        original: originalFile,
        ...stats,
      });
    }
    return infos;
  }

  /**
   * Retrieve the cached mapping metadata for a round, computing it if needed.
   */
  public getRoundMapping(currRound: number): RoundFileMapping {
    const existing = this.roundMappings[currRound];
    if (existing) {
      return existing;
    }

    const currentNamed = this.getNamedOutputs(currRound);
    const currentRelatives = currentNamed.map(
      (entry) => entry.relativePath ?? entry.path,
    );

    const baseToOutput = createFileMapping(
      this.baseFiles,
      currentRelatives,
      'contains',
    );

    const prevNamed = currRound > 0 ? this.getNamedOutputs(currRound - 1) : [];
    const prevRelatives = prevNamed.map(
      (entry) => entry.relativePath ?? entry.path,
    );

    const prevToOutput =
      currRound > 0
        ? createFileMapping(prevRelatives, currentRelatives, 'basename', true)
        : new Map<string, string>();

    const originByOutput = new Map(
      currentNamed.map((entry) => [
        entry.relativePath ?? entry.path,
        entry.source,
      ]),
    );

    const workspaceByOutput = new Map<string, string>();
    const storageByOutput = new Map<string, string>();

    const registerEntry = (
      entry: NamedOutputFile,
      { skipIfExists = false }: { skipIfExists?: boolean } = {},
    ) => {
      const key = entry.relativePath ?? entry.path;
      if (skipIfExists && storageByOutput.has(key)) {
        return;
      }
      if (entry.workspacePath && !workspaceByOutput.has(key)) {
        workspaceByOutput.set(key, entry.workspacePath);
      }
      if (!storageByOutput.has(key) || !skipIfExists) {
        storageByOutput.set(key, entry.path);
      }
    };

    currentNamed.forEach((entry) => registerEntry(entry));
    prevNamed.forEach((entry) => registerEntry(entry, { skipIfExists: true }));

    const mapping: RoundFileMapping = {
      baseToOutput,
      prevToOutput,
      originByOutput,
      workspaceByOutput,
      storageByOutput,
    };
    this.roundMappings[currRound] = mapping;
    return mapping;
  }

  private getNamedOutputs(round: number): NamedOutputFile[] {
    if (!this.outputMappings[round]) {
      this.outputMappings[round] = [];
    }
    return this.outputMappings[round];
  }

  private invalidateRoundMapping(round: number): void {
    delete this.roundMappings[round];
  }

  private invalidateMappingsFromRound(round: number): void {
    this.invalidateRoundMapping(round);
    this.invalidateRoundMapping(round + 1);
  }

  private async relocateRoundArtifacts(
    rawOutputPath: string,
    processed: NamedOutputFile[],
  ): Promise<{
    raw: string;
    processed: NamedOutputFile[];
  }> {
    let relocatedRaw = rawOutputPath;
    let rawRelocation:
      | {
          storagePath: string;
          relativePath: string;
          workspacePath: string;
        }
      | undefined;

    if (rawOutputPath) {
      await this.cleanupLatexBackups(rawOutputPath);
      rawRelocation =
        await this.fileService.relocateToRunStorage(rawOutputPath);
      relocatedRaw = rawRelocation.storagePath;
    }

    const relocatedProcessed: NamedOutputFile[] = [];
    for (const entry of processed) {
      try {
        if (rawRelocation && entry.path === rawOutputPath) {
          relocatedProcessed.push({
            ...entry,
            path: rawRelocation.storagePath,
            relativePath: rawRelocation.relativePath,
            workspacePath: entry.workspacePath ?? rawRelocation.workspacePath,
          });
          continue;
        }

        await this.cleanupLatexBackups(entry.path);
        const relocation = await this.fileService.relocateToRunStorage(
          entry.path,
        );
        relocatedProcessed.push({
          ...entry,
          path: relocation.storagePath,
          relativePath: relocation.relativePath,
          workspacePath: entry.workspacePath ?? relocation.workspacePath,
        });
      } catch (error) {
        throw Object.assign(
          new Error(
            `Failed to relocate processed output ${entry.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          { cause: error },
        );
      }
    }

    return { raw: relocatedRaw, processed: relocatedProcessed };
  }

  /**
   * Set output files and mappings for a round, invalidating the cache.
   * @param round The round number
   * @param files The output file paths
   * @param mappings The named output file mappings
   */
  private setRoundOutputs(
    round: number,
    files: string[],
    mappings: NamedOutputFile[],
  ): void {
    this.outputFiles[round] = files;
    this.outputMappings[round] = mappings;
    this.invalidateMappingsFromRound(round);
  }

  public async validateExpectedOutputs(
    outputFile: string,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void> {
    await this.withOutputStage(
      `Validate expected r${currRound}`,
      stage,
      async () => {
        const expected = this.agentConfig.outputFiles;
        if (!expected || expected.length === 0) {
          bus.emit('updateMissingOutputs', {
            stream: this.channel,
            groupId: this.currentRunId ?? undefined,
            filesByRound: { [currRound]: [] },
          });
          return;
        }

        const checks = expected.map(async (file) => ({
          file,
          exists: await AbsoluteFS.exists(
            this.fileService.resolveExpectedPath(file),
          ),
        }));
        const results = await Promise.all(checks);
        const missing = results.filter((r) => !r.exists).map((r) => r.file);

        if (missing.length > 0) {
          const xmlPath = outputFile
            ? outputFile
            : getOutputFileName(
                this.agentConfig.inputFile,
                this.agentConfig.agent,
                this.agentConfig.model,
                'xml',
                currRound,
              );

          const resolvedXmlPath = this.fileService.resolveExpectedPath(xmlPath);
          const xmlExists = await AbsoluteFS.exists(resolvedXmlPath);

          const missingOutputsData = {
            missing,
            xmlFile: xmlExists ? xmlPath : null,
            documentTag: this.agentSetting.documentTag,
          };

          this.logger.missingOutputs(missingOutputsData);
          await showInstructionWithSuppress(
            'missingOutputsInfo',
            'Missing output files detected',
          );
          this.logger.debug(
            `Missing expected outputs for round ${currRound}: ${missing.join(', ')}`,
          );
        } else {
          this.logger.debug(
            `All expected outputs exist after round ${currRound}`,
          );
        }

        bus.emit('updateMissingOutputs', {
          stream: this.channel,
          groupId: this.currentRunId ?? undefined,
          filesByRound: { [currRound]: missing },
        });
      },
    );
  }

  /**
   * Finalize processing for a conversation round.
   * Gathers file info, validates expected outputs and
   * emits an event with the collected files.
   */
  public async finalizeRound(
    outputFile: string,
    currRound: number,
    options: { endTurn: boolean; stage?: AgentLogStage },
  ): Promise<void> {
    const { endTurn, stage } = options;
    await this.withOutputStage(
      `Finalize r${currRound}`,
      stage,
      async (scope) => {
        this.ensureRound(currRound);
        if (!this.rawOutputs[currRound]) {
          this.rawOutputs[currRound] = outputFile
            ? this.fileService.resolveExpectedPath(outputFile)
            : null;
        }
        const fileInfos = await this.gatherOutputFileInfo(currRound);
        this.roundFileInfos[currRound] = fileInfos;

        if (endTurn) {
          try {
            await this.validateExpectedOutputs(outputFile, currRound, scope);
            this.logger.debug(
              `Expected outputs validated for round ${currRound}`,
            );
          } catch (error) {
            this.logger.error(
              `Expected output validation failed after round ${currRound}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        bus.emit('addOutputFiles', {
          stream: this.channel,
          groupId: this.currentRunId ?? undefined,
          filesByRound: { [currRound]: fileInfos },
        });

        for (const { path: filePath } of fileInfos) {
          if (this.openedOutputs.has(filePath)) {
            continue;
          }

          try {
            await openBuildDisplayIfTex(filePath, { preserveFocus: true });
            this.openedOutputs.add(filePath);
          } catch (error) {
            this.logger.error(
              `Failed to open output file ${filePath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      },
    );
  }

  /**
   * Processes output files from XML or direct input.
   */
  public async processOutputFiles(
    outputFile: string,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void> {
    await this.withOutputStage(
      `Process files r${currRound}`,
      stage,
      async (scope) => {
        this.ensureRound(currRound);

        const handleMultipleOutputs = async () => {
          this.logger.debug(
            `Processing multiple outputs for ${outputFile}; outputFiles: ${this.agentConfig.outputFiles}`,
          );

          try {
            const processedPairs =
              await this.xmlManager.processMultipleXmlOutputs(outputFile);

            if (processedPairs && processedPairs.length > 0) {
              const processedFiles = processedPairs.map((p) => p.path);
              await this.indentLatexFiles(processedFiles);
              this.logger.debug(
                `Indented multiple output files: ${processedFiles.join(',')}`,
              );

              const relocated = await this.relocateRoundArtifacts(
                outputFile,
                processedPairs,
              );
              const relocatedFiles = relocated.processed.map((p) => p.path);

              if (this.baseFiles && this.baseFiles.length > 0) {
                await replaceInputCommands(
                  this.baseFiles,
                  relocatedFiles,
                  this.logger,
                );
              }
              this.setRoundOutputs(
                currRound,
                relocatedFiles,
                relocated.processed,
              );
              await this.captureXmlSummary(
                currRound,
                relocated.raw,
                relocated.processed,
                scope,
              );
              outputFile = relocated.raw;
              this.rawOutputs[currRound] = relocated.raw;
              return;
            }

            this.logger.debug(
              `No processed files were generated from ${outputFile}`,
            );
            this.setRoundOutputs(currRound, [], []);
            await this.captureXmlSummary(currRound, outputFile, [], scope);
            if (outputFile) {
              await this.cleanupLatexBackups(outputFile);
              const relocation =
                await this.fileService.relocateToRunStorage(outputFile);
              outputFile = relocation.storagePath;
              this.rawOutputs[currRound] = relocation.storagePath;
            }
          } catch (err) {
            this.logger.debug(
              `Error processing output files: ${err instanceof Error ? err.message : String(err)}`,
              undefined,
              MESSAGE_TYPES.INTERNAL,
            );
            this.setRoundOutputs(currRound, [], []);
            await this.captureXmlSummary(currRound, outputFile, [], scope);
          }
        };

        const handleSingleOutput = async () => {
          this.logger.debug(`Processing single output for ${outputFile}`);

          try {
            let processed: NamedOutputFile = {
              source: outputFile,
              path: outputFile,
              relativePath: outputFile,
            };
            const hasScratchpadPrefill =
              this.agentSetting.prefills?.some((prefill) =>
                /<scratchpad\s*>/i.test(prefill),
              ) ?? false;
            const shouldProcessXml =
              this.agentSetting.agentType === AgentType.CoT ||
              (this.agentSetting.agentType === AgentType.Direct &&
                hasScratchpadPrefill);

            if (shouldProcessXml) {
              processed =
                await this.xmlManager.processSingleXmlOutput(outputFile);
            }

            const hasProcessedPath = Boolean(processed && processed.path);

            if (hasProcessedPath && processed.path) {
              await this.indentLatexFile(processed.path);
              this.logger.debug(
                `Indented single output file: ${processed.path}`,
              );
            }

            const relocation = await this.relocateRoundArtifacts(
              outputFile,
              hasProcessedPath && processed.path ? [processed] : [],
            );
            const relocatedFiles = relocation.processed.map((p) => p.path);

            if (hasProcessedPath) {
              if (this.baseFiles && this.baseFiles.length > 0) {
                await replaceInputCommands(
                  this.baseFiles,
                  relocatedFiles,
                  this.logger,
                );
              }

              this.setRoundOutputs(
                currRound,
                relocatedFiles,
                relocation.processed,
              );
            } else {
              this.logger.debug(
                `No processed file was generated from ${outputFile}`,
              );
              this.setRoundOutputs(currRound, [], []);
            }

            await this.captureXmlSummary(
              currRound,
              relocation.raw,
              relocation.processed,
              scope,
            );
            outputFile = relocation.raw;
            this.rawOutputs[currRound] = relocation.raw;
          } catch (err) {
            this.logger.debug(
              `Error processing output file: ${err instanceof Error ? err.message : String(err)}`,
              undefined,
              MESSAGE_TYPES.INTERNAL,
            );
            const missingOutputsData = {
              missing: [],
              xmlFile: outputFile,
              documentTag: this.agentSetting.documentTag,
            };
            this.logger.missingOutputs(missingOutputsData);
            bus.emit('updateMissingOutputs', {
              stream: this.channel,
              groupId: this.currentRunId ?? undefined,
              filesByRound: { [currRound]: [] },
            });
            this.setRoundOutputs(currRound, [], []);
            await this.captureXmlSummary(currRound, outputFile, [], scope);
          }
        };

        if (
          Array.isArray(this.agentConfig.outputFiles) &&
          this.agentConfig.outputFiles.length > 0
        ) {
          await handleMultipleOutputs();
          return;
        }

        await handleSingleOutput();
      },
    );
  }

  public async getRoundArtifacts(round: number): Promise<RoundOutputArtifacts> {
    const outputFiles = this.ensureRound(round).slice();
    const processed = this.getNamedOutputs(round).map((entry) => ({
      ...entry,
    }));
    let fileInfos = this.roundFileInfos[round];
    if (!fileInfos) {
      fileInfos = await this.gatherOutputFileInfo(round);
      this.roundFileInfos[round] = fileInfos;
    }

    return {
      round,
      rawOutputPath: this.rawOutputs[round] ?? null,
      outputFiles,
      processedFiles: processed,
      fileInfos,
      xmlSummary: this.getRoundXmlSummary(round),
    };
  }

  public getRoundXmlSummary(round: number): OutputXmlSummary {
    return (
      this.roundXmlSummaries[round] ?? {
        tagContents: {},
        documents: [],
        singleOutputFile: null,
      }
    );
  }

  private async captureXmlSummary(
    round: number,
    rawOutputPath: string,
    processed: NamedOutputFile[],
    stage?: AgentLogStage,
  ): Promise<void> {
    const run = async () => {
      const singleFile = processed.length === 1 ? processed[0].path : null;

      if (!rawOutputPath) {
        this.roundXmlSummaries[round] = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
        };
        return;
      }

      try {
        const rawContent = await readFlexible(rawOutputPath);
        const tagContents: Record<string, string | string[]> = {};
        const documents: string[] = [];

        const documentTag = this.agentSetting.documentTag;
        const documentEntries = extractMultipleTextFromTag(
          rawContent,
          documentTag,
        );
        if (documentEntries.length > 0) {
          const trimmedDocuments = documentEntries.map((entry) =>
            entry.content.trim(),
          );
          if (trimmedDocuments.length === 1) {
            tagContents[documentTag] = trimmedDocuments[0];
          } else {
            tagContents[documentTag] = trimmedDocuments;
          }

          for (const entry of documentEntries) {
            const nameAttr = entry.name ? ` name="${entry.name}"` : '';
            const trimmed = entry.content.trim();
            documents.push(
              `<${documentTag}${nameAttr}>${trimmed}</${documentTag}>`,
            );
          }
        } else {
          const singleDocument = extractTextFromTag(
            rawContent,
            documentTag,
          ).trim();
          if (singleDocument) {
            tagContents[documentTag] = singleDocument;
            documents.push(
              `<${documentTag}>${singleDocument}</${documentTag}>`,
            );
          }
        }

        const scratchpadContent = extractTextFromTag(
          rawContent,
          'scratchpad',
        ).trim();
        if (scratchpadContent) {
          tagContents.scratchpad = scratchpadContent;
        }

        this.roundXmlSummaries[round] = {
          tagContents,
          documents,
          singleOutputFile: singleFile,
        };
      } catch (error) {
        this.logger.debug(
          `Failed to collect XML summary for round ${round}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
        this.roundXmlSummaries[round] = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
        };
      }
    };

    if (stage) {
      await stage.within(run);
      return;
    }

    await run();
  }
}

export interface RoundOutputArtifacts {
  round: number;
  rawOutputPath: string | null;
  outputFiles: string[];
  processedFiles: NamedOutputFile[];
  fileInfos: OutputFileInfo[];
  xmlSummary: OutputXmlSummary;
}

export interface OutputXmlSummary {
  tagContents: Record<string, string | string[]>;
  documents: string[];
  singleOutputFile: string | null;
}
