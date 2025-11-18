// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import {
  AgentSetting,
  AgentType,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import { getOutputFileName } from '@agent/utils/outputFileUtils';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  replaceInputCommands,
  createFileMapping,
  TaskRunFileService,
  flexibleFS,
} from '@utils/files';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
// Type imports
import type { FileLocation } from '@utils/files';

// Internal imports
import { getEffectiveBaseFile } from '@utils/files/baseFileUtils';
import {
  extractMultipleTextFromTag,
  extractTextFromTag,
} from '@utils/text/xmlUtils';
import { bus } from '@eventBus/ProgressEventBus';
import { runLatexFormatter } from '@latex/texFormatter';

// Local file imports
import { XmlOutputManager } from './XmlOutputManager';
import {
  type NamedOutputFile,
  type OutputFileInfo,
  type OutputXmlSummary,
  type RoundFileMapping,
  type RoundOutputArtifacts,
} from './types';
import { LatexDiffManager } from './LatexDiffManager';
import { DiffStatsManager } from './DiffStatsManager';

// Type imports
import type { IOutputHandler } from './IOutputHandler';

// Local imports - types

/** Handles output file processing and validation for agent responses. */
export class OutputHandler implements IOutputHandler {
  public agentSetting: AgentWorkflowSetting;
  public agentConfig: AgentConfig;
  public logId: number;
  public outputFiles: { [key: number]: NamedOutputFile[] };
  public outputMappings: { [key: number]: NamedOutputFile[] };
  private rawOutputs: { [key: number]: FileLocation | null };
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
  private runPreparation: Promise<void> | null;

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
      this.fileService,
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
    this.runPreparation = null;
  }

  private collectRunSnapshotFiles(): string[] {
    const unique = new Set<string>();
    for (const candidate of this.baseFiles) {
      if (!candidate) {
        continue;
      }
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        continue;
      }
      unique.add(trimmed);
    }
    return Array.from(unique);
  }

  private collectRunSupportFiles(): string[] {
    const extras = new Set<string>();
    const add = (value?: string | null) => {
      if (!value) {
        return;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return;
      }
      extras.add(trimmed);
    };

    const cfg = this.agentConfig;
    add(cfg.referenceFile ?? undefined);
    cfg.referenceFiles.forEach((file) => add(file));
    add(cfg.auxiliaryFile ?? undefined);
    cfg.auxiliaryFiles.forEach((file) => add(file));
    add(cfg.mediaFile ?? undefined);
    cfg.mediaFiles.forEach((file) => add(file));
    add(cfg.inputFile ?? undefined);
    cfg.inputFiles.forEach((file) => add(file));

    return Array.from(extras);
  }

  public setActiveRun(runId?: string | null): void {
    const nextRunId = runId ?? null;
    if (nextRunId === this.currentRunId) {
      return;
    }

    this.currentRunId = nextRunId;
    this.openedOutputs.clear();
    this.fileService.updateRunContext(nextRunId ?? undefined);

    if (nextRunId) {
      const snapshotTargets = this.collectRunSnapshotFiles();
      const supportFiles = this.collectRunSupportFiles();
      this.runPreparation = this.fileService.prepareRunWorkspace(
        snapshotTargets,
        { linkFiles: supportFiles },
      );
    } else {
      this.runPreparation = null;
    }
  }

  private async prepareRunWorkspaceIfNeeded(): Promise<void> {
    if (!this.runPreparation) {
      return;
    }

    try {
      await this.runPreparation;
    } catch (error) {
      this.logger.debug(
        `Failed to prepare run workspace: ${toErrorMessage(error)}`,
        undefined,
        MESSAGE_TYPES.INTERNAL,
      );
    } finally {
      this.runPreparation = null;
    }
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
  public ensureRound(round: number): NamedOutputFile[] {
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
    original?: string | FileLocation | null,
  ): Promise<void> {
    if (!original) {
      return;
    }

    const workspaceRoot = WorkspaceFS.getPath();
    if (!workspaceRoot) {
      return;
    }

    const workspaceLocation = this.fileService.getWorkspaceLocation(original);
    if (!workspaceLocation) {
      return;
    }

    const workspaceAbsolute = workspaceLocation.absolutePath;

    if (!workspaceAbsolute) {
      return;
    }

    const { dir, base, name } = path.parse(workspaceAbsolute);
    const backupCandidates = new Set<string>([
      path.join(dir, `${base}.bak`),
      path.join(dir, `${base}.bak0`),
      path.join(dir, `${base}.bak1`),
      path.join(dir, `${name}.bak`),
      path.join(dir, `${name}.bak0`),
      path.join(dir, `${name}.bak1`),
    ]);

    for (const candidateAbsolute of backupCandidates) {
      const relative = path.relative(workspaceRoot, candidateAbsolute);
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
          `Failed to remove latexindent backup ${relative}: ${toErrorMessage(error)}`,
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
    const baseByOutput = new Map<string, string>();
    const prevByOutput = new Map<string, string>();

    mapping.baseToOutput.forEach((output, base) => {
      baseByOutput.set(output, base);
    });
    mapping.prevToOutput.forEach((output, prev) => {
      prevByOutput.set(output, prev);
    });

    const rawLocation = this.rawOutputs[currRound] ?? null;
    const xmlSummary = this.getRoundXmlSummary(currRound);
    const xmlSummarySnapshot: OutputXmlSummary = {
      tagContents: { ...xmlSummary.tagContents },
      documents: [...xmlSummary.documents],
      singleOutputFile: xmlSummary.singleOutputFile,
      sourceLocation: xmlSummary.sourceLocation ?? rawLocation ?? null,
    };

    const locationFor = (relative: string | null): FileLocation | null => {
      if (!relative) return null;
      return mapping.locationByOutput.get(relative) ?? null;
    };

    for (const output of roundOutputs) {
      const location = output.location;
      const relativePath = location.relativePath;

      const baseFile = baseByOutput.get(relativePath) ?? null;
      const prevFile = prevByOutput.get(relativePath) ?? null;
      const originalFile = mapping.originByOutput.get(relativePath) || null;

      const diffBaseRelative = getEffectiveBaseFile(
        baseFile,
        originalFile,
        relativePath,
      );
      const diffBaseLocation = locationFor(diffBaseRelative);
      const diffBaseActual = diffBaseLocation?.absolutePath ?? null;
      const stats = await this.diffStatsManager.computeDiffStats(
        diffBaseActual,
        location.absolutePath,
      );

      const workspacePath = location.workspace?.absolutePath ?? null;
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
        path: location.absolutePath,
        relativePath,
        displayLabel,
        displayDir,
        workspacePath: workspacePath ?? null,
        base: baseFile,
        prev: prevFile,
        original: originalFile,
        location,
        baseLocation: diffBaseLocation ?? null,
        prevLocation: locationFor(prevFile),
        originalLocation: locationFor(originalFile),
        source: output.source ?? relativePath ?? null,
        rawOutputPath: rawLocation?.absolutePath ?? null,
        rawLocation: rawLocation ?? null,
        xmlSummary: xmlSummarySnapshot,
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
      (entry) => entry.location.relativePath,
    );

    const baseToOutput = createFileMapping(
      this.baseFiles,
      currentRelatives,
      'contains',
    );

    const prevNamed = currRound > 0 ? this.getNamedOutputs(currRound - 1) : [];
    const prevRelatives = prevNamed.map((entry) => entry.location.relativePath);

    const prevToOutput =
      currRound > 0
        ? createFileMapping(prevRelatives, currentRelatives, 'basename', true)
        : new Map<string, string>();

    const originByOutput = new Map(
      currentNamed.map((entry) => [entry.location.relativePath, entry.source]),
    );

    const locationByOutput = new Map<string, FileLocation>();

    const registerEntry = (
      entry: NamedOutputFile,
      { skipIfExists = false }: { skipIfExists?: boolean } = {},
    ) => {
      const key = entry.location.relativePath;
      if (skipIfExists && locationByOutput.has(key)) {
        return;
      }
      if (!locationByOutput.has(key) || !skipIfExists) {
        locationByOutput.set(key, entry.location);
      }
    };

    currentNamed.forEach((entry) => registerEntry(entry));
    prevNamed.forEach((entry) => registerEntry(entry, { skipIfExists: true }));

    const mapping: RoundFileMapping = {
      baseToOutput,
      prevToOutput,
      originByOutput,
      locationByOutput,
    };
    this.roundMappings[currRound] = mapping;
    return mapping;
  }

  private buildNamedOutputsFromInfos(
    infos: OutputFileInfo[],
  ): NamedOutputFile[] {
    return infos.map((info) => ({
      source: info.source ?? info.relativePath,
      path: info.location.absolutePath,
      relativePath: info.location.relativePath,
      workspacePath: info.workspacePath ?? undefined,
      location: info.location,
    }));
  }

  private applyHydratedRound(round: number, infos: OutputFileInfo[]): void {
    if (infos.length === 0) {
      delete this.outputFiles[round];
      delete this.outputMappings[round];
      delete this.roundFileInfos[round];
      delete this.roundXmlSummaries[round];
      delete this.rawOutputs[round];
      this.invalidateMappingsFromRound(round);
      return;
    }

    this.roundFileInfos[round] = infos;
    this.outputFiles[round] = this.buildNamedOutputsFromInfos(infos);
    this.outputMappings[round] = this.outputFiles[round];

    const rawSource =
      infos.find((info) => info.rawLocation || info.rawOutputPath) ?? infos[0];

    const rawLocation = rawSource?.rawLocation ?? null;

    this.rawOutputs[round] = rawLocation ?? null;

    const summary = infos
      .map((info) => info.xmlSummary ?? null)
      .find((value) => value !== null);

    if (summary) {
      this.roundXmlSummaries[round] = {
        tagContents: { ...summary.tagContents },
        documents: [...summary.documents],
        singleOutputFile: summary.singleOutputFile,
        sourceLocation: summary.sourceLocation ?? rawLocation ?? null,
      };
    } else {
      delete this.roundXmlSummaries[round];
    }

    this.invalidateMappingsFromRound(round);
  }

  public hydrateFromArtifacts(
    runId: string | null | undefined,
    rounds: Map<number, OutputFileInfo[]>,
  ): void {
    const normalizedRunId = runId ?? this.currentRunId ?? null;
    if (normalizedRunId !== this.currentRunId) {
      this.setActiveRun(normalizedRunId);
    }

    for (const [round, infos] of rounds.entries()) {
      const entries = Array.isArray(infos) ? infos : [];
      this.applyHydratedRound(round, entries);
    }
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

  /**
   * Set output files and mappings for a round, invalidating the cache.
   * @param round The round number
   * @param files The output file paths
   * @param mappings The named output file mappings
   */
  private setRoundOutputs(round: number, outputs: NamedOutputFile[]): void {
    this.outputFiles[round] = outputs;
    this.outputMappings[round] = outputs;
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
            executionId: this.fileService.getExecutionId(),
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
          executionId: this.fileService.getExecutionId(),
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
        const rawLocation =
          this.rawOutputs[currRound] ??
          (outputFile
            ? this.fileService.resolveRelativePath(outputFile)
            : null);
        this.rawOutputs[currRound] = rawLocation;

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
              `Expected output validation failed after round ${currRound}: ${toErrorMessage(error)}`,
            );
          }
        }

        bus.emit('addOutputFiles', {
          stream: this.channel,
          groupId: this.currentRunId ?? undefined,
          executionId: this.fileService.getExecutionId(),
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
              `Failed to open output file ${filePath}: ${toErrorMessage(error)}`,
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
        await this.prepareRunWorkspaceIfNeeded();

        const rawLocation =
          this.rawOutputs[currRound] ??
          (outputFile
            ? this.fileService.resolveRelativePath(outputFile)
            : null);
        this.rawOutputs[currRound] = rawLocation;
        let rawPath = rawLocation?.absolutePath ?? outputFile;

        const handleMultipleOutputs = async () => {
          this.logger.debug(
            `Processing multiple outputs for ${outputFile}; outputFiles: ${this.agentConfig.outputFiles}`,
          );

          try {
            const processedPairs =
              await this.xmlManager.processMultipleXmlOutputs(outputFile);

            if (processedPairs && processedPairs.length > 0) {
              const processedFiles = processedPairs.map((p) => p.location.absolutePath);
              await this.indentLatexFiles(processedFiles);
              this.logger.debug(
                `Indented multiple output files: ${processedFiles.join(',')}`,
              );

              if (this.baseFiles && this.baseFiles.length > 0) {
                await replaceInputCommands(
                  this.baseFiles,
                  processedFiles,
                  this.logger,
                );
              }
              this.setRoundOutputs(currRound, processedPairs);
              await this.captureXmlSummary(
                currRound,
                rawLocation,
                processedPairs,
                scope,
              );
              return;
            }

            this.logger.debug(
              `No processed files were generated from ${outputFile}`,
            );
            this.setRoundOutputs(currRound, []);
            if (outputFile) {
              await this.cleanupLatexBackups(rawLocation ?? outputFile);
              rawPath = rawLocation?.absolutePath ?? outputFile;
              outputFile = rawPath;
            }
            await this.captureXmlSummary(currRound, rawLocation, [], scope);
            if (outputFile) {
              await this.cleanupLatexBackups(rawLocation);
            }
          } catch (err) {
            this.logger.debug(
              `Error processing output files: ${toErrorMessage(err)}`,
              undefined,
              MESSAGE_TYPES.INTERNAL,
            );
            this.setRoundOutputs(currRound, []);
            if (outputFile) {
              await this.cleanupLatexBackups(rawLocation ?? outputFile);
              rawPath = rawLocation?.absolutePath ?? outputFile;
              outputFile = rawPath;
            }
            await this.captureXmlSummary(currRound, rawLocation, [], scope);
            if (outputFile) {
              await this.cleanupLatexBackups(rawLocation);
            }
          }
        };

        const handleSingleOutput = async () => {
          this.logger.debug(`Processing single output for ${outputFile}`);

          try {
            const processedLocation = rawLocation
              ? { ...rawLocation }
              : this.fileService.resolveRelativePath(outputFile);
            let processed: NamedOutputFile = {
              source: outputFile,
              path: processedLocation.absolutePath,
              relativePath: processedLocation.relativePath,
              workspacePath: processedLocation.workspace?.absolutePath,
              location: processedLocation,
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

            const hasProcessedPath = Boolean(processed && processed.location);

            if (hasProcessedPath && processed.location) {
              await this.indentLatexFile(processed.location.absolutePath);
              this.logger.debug(
                `Indented single output file: ${processed.location.absolutePath}`,
              );
            }

            const resolvedRawPath = rawLocation?.absolutePath ?? rawPath;
            outputFile = resolvedRawPath;
            const processedFiles = hasProcessedPath ? [processed] : [];

            if (hasProcessedPath) {
              if (this.baseFiles && this.baseFiles.length > 0) {
                await replaceInputCommands(
                  this.baseFiles,
                  processedFiles.map((entry) => entry.location.absolutePath),
                  this.logger,
                );
              }

              this.setRoundOutputs(currRound, processedFiles);
            } else {
              this.logger.debug(
                `No processed file was generated from ${outputFile}`,
              );
              this.setRoundOutputs(currRound, []);
            }

            await this.captureXmlSummary(
              currRound,
              rawLocation,
              processedFiles,
              scope,
            );
          } catch (err) {
            this.logger.debug(
              `Error processing output file: ${toErrorMessage(err)}`,
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
              executionId: this.fileService.getExecutionId(),
              filesByRound: { [currRound]: [] },
            });
            this.setRoundOutputs(currRound, []);
            await this.captureXmlSummary(
              currRound,
              this.rawOutputs[currRound] ?? rawLocation ?? null,
              [],
              scope,
            );
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
    const outputFiles = this.ensureRound(round).map((entry) => ({ ...entry }));
    const processed = this.getNamedOutputs(round).map((entry) => ({
      ...entry,
    }));
    let fileInfos = this.roundFileInfos[round];
    if (!fileInfos) {
      fileInfos = await this.gatherOutputFileInfo(round);
      this.roundFileInfos[round] = fileInfos;
    }

    const rawLocation = this.rawOutputs[round] ?? null;

    return {
      round,
      rawOutput: rawLocation,
      rawOutputPath: rawLocation?.absolutePath ?? null,
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
        sourceLocation: null,
      }
    );
  }

  private async captureXmlSummary(
    round: number,
    rawOutput: FileLocation | null,
    processed: NamedOutputFile[],
    stage?: AgentLogStage,
  ): Promise<void> {
    const run = async () => {
      const singleFile = processed.length === 1 ? processed[0].location.absolutePath : null;
      const sourceLocation = rawOutput ?? this.rawOutputs[round] ?? null;

      if (!rawOutput?.absolutePath) {
        this.roundXmlSummaries[round] = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
          sourceLocation,
        };
        return;
      }

      try {
        const rawContent = await flexibleFS.read(rawOutput.absolutePath);
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
          sourceLocation,
        };
      } catch (error) {
        this.logger.debug(
          `Failed to collect XML summary for round ${round}: ${toErrorMessage(error)}`,
          undefined,
          MESSAGE_TYPES.INTERNAL,
        );
        this.roundXmlSummaries[round] = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
          sourceLocation,
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
