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
import { normalizeRunId } from '@progressView/constants/runIds';
import {
  replaceInputCommands,
  createFileMapping,
  TaskRunFileService,
  flexibleFS,
  WorkspaceFS,
  AbsoluteFS,
  getComparablePath,
} from '@utils/files';
// Type imports

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
  type FileLocation,
  type OutputFileInfo,
  type OutputXmlSummary,
  type RoundFileMapping,
  type RoundOutput,
} from './types';
import { LatexDiffManager } from './LatexDiffManager';
import { DiffStatsManager } from './DiffStatsManager';

// Type imports
import type { IOutputHandler } from './IOutputHandler';

// Local imports - types

/**
 * Complete round data containing outputs and metadata.
 */
interface RoundData {
  outputs: OutputFileInfo[];
  rawOutput: FileLocation | null;
  xmlSummary: OutputXmlSummary;
}

/** Handles output file processing and validation for agent responses. */
export class OutputHandler implements IOutputHandler {
  public agentSetting: AgentWorkflowSetting;
  public agentConfig: AgentConfig;
  public logId: number;
  // Single source of truth for all round data
  private rounds: Map<number, RoundData>;

  // Backward-compatible getter for external consumers (LatexDiffManager)
  public get outputFiles(): { [key: number]: OutputFileInfo[] } {
    const result: { [key: number]: OutputFileInfo[] } = {};
    this.rounds.forEach((data, round) => {
      result[round] = data.outputs;
    });
    return result;
  }
  public baseFiles: FileLocation[];
  protected logger: AgentLogger;
  protected channel: string;
  public readonly xmlManager: XmlOutputManager;
  public readonly diffManager: LatexDiffManager;
  private diffStatsManager: DiffStatsManager;
  private readonly openedOutputs: Set<string>;
  private readonly fileService: TaskRunFileService;
  private readonly executionId?: string;
  private currentRunId: string | null | undefined;
  private runPreparation: Promise<void> | null;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    logId: number,
    baseFiles: FileLocation[] = [],
    logger?: AgentLogger,
    fileService?: TaskRunFileService,
    executionId?: string | null,
  ) {
    this.agentSetting = requireWorkflowSetting(agentSetting);
    this.agentConfig = agentConfig;
    this.logId = logId;
    this.rounds = new Map();
    this.baseFiles = baseFiles;
    this.logger = logger || new AgentLogger('OutputHandler');
    this.channel = this.logger.channelId;
    this.fileService = fileService || new TaskRunFileService();
    this.executionId = executionId ?? this.fileService.getExecutionId();

    this.xmlManager = new XmlOutputManager(
      this.agentSetting,
      this.agentConfig,
      this.logger,
      this.fileService,
    );
    this.diffManager = new LatexDiffManager(
      this.agentSetting,
      () => this.outputFiles, // Pass function reference instead of snapshot
      this.baseFiles,
      this.logger,
      this.channel,
      this.fileService,
    );
    this.diffStatsManager = new DiffStatsManager();
    this.openedOutputs = new Set();
    this.currentRunId = undefined;
    this.runPreparation = null;

    const initialRunId = this.logger.withCurrentGroup((id) => id);
    this.setActiveRun(initialRunId ?? null);
    this.logger.debug(
      `OutputHandler initialized with runId=${normalizeRunId(this.currentRunId)} (loggerGroup=${normalizeRunId(initialRunId)} executionId=${
        this.executionId ?? 'none'
      })`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
  }

  private collectRunSnapshotFiles(): FileLocation[] {
    return this.baseFiles.filter((candidate) => candidate !== null);
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
    const targetExecutionId =
      this.executionId ?? this.fileService.getExecutionId();
    this.fileService.updateRunContext(targetExecutionId ?? undefined);

    const loggerRunId = this.logger.withCurrentGroup((id) => id);
    const nextRunId = runId ?? loggerRunId ?? null;
    const previousRunId = this.currentRunId;
    this.logger.debug(
      `setActiveRun(runId=${normalizeRunId(runId)} loggerRunId=${normalizeRunId(loggerRunId)} prev=${normalizeRunId(
        previousRunId,
      )} next=${normalizeRunId(nextRunId)} executionId=${targetExecutionId ?? 'none'})`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
    if (nextRunId === this.currentRunId) {
      return;
    }

    this.currentRunId = nextRunId;
    this.openedOutputs.clear();

    if (targetExecutionId) {
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

  private getActiveRunId(): string {
    const loggerRunId = this.logger.withCurrentGroup((id) => id);
    if (loggerRunId && loggerRunId !== this.currentRunId) {
      this.logger.debug(
        `Logger group changed: current=${normalizeRunId(this.currentRunId)} logger=${normalizeRunId(loggerRunId)}`,
        { messageType: MESSAGE_TYPES.INTERNAL },
      );
      this.setActiveRun(loggerRunId);
    }

    return normalizeRunId(this.currentRunId);
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
        { messageType: MESSAGE_TYPES.INTERNAL },
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
  /**
   * Get or create round data.
   */
  private ensureRoundData(round: number): RoundData {
    let data = this.rounds.get(round);
    if (!data) {
      data = {
        outputs: [],
        rawOutput: null,
        xmlSummary: {
          tagContents: {},
          documents: [],
          singleOutputFile: null,
          sourceLocation: null,
        },
      };
      this.rounds.set(round, data);
    }
    return data;
  }

  public ensureRound(round: number): OutputFileInfo[] {
    return this.ensureRoundData(round).outputs;
  }

  public hasRoundOutputs(round: number): boolean {
    return (this.rounds.get(round)?.outputs.length ?? 0) > 0;
  }

  /**
   * Indents a LaTeX file for better readability
   */
  public async indentLatexFile(fileLocation: FileLocation): Promise<void> {
    if (!fileLocation.absolutePath.includes('.tex')) {
      return;
    }
    this.logger.debug(`Formatting ${fileLocation.absolutePath}`);
    await runLatexFormatter(fileLocation.absolutePath);
  }

  /**
   * Indents multiple LaTeX files for better readability
   */
  public async indentLatexFiles(fileLocations: FileLocation[]): Promise<void> {
    for (const location of fileLocations) {
      await this.indentLatexFile(location);
    }
  }

  private async cleanupLatexBackups(
    fileLocation: FileLocation | null,
  ): Promise<void> {
    if (!fileLocation) {
      return;
    }

    const workspaceRoot = WorkspaceFS.getPath();
    if (!workspaceRoot) {
      return;
    }

    const originalLocation = fileLocation;
    if (originalLocation.kind !== 'workspace') {
      return;
    }
    const workspaceAbsolute = originalLocation.absolutePath;

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
   * Computes diff stats in parallel for better performance.
   */
  public async gatherOutputFileInfo(
    currRound: number,
  ): Promise<OutputFileInfo[]> {
    const roundOutputs = this.ensureRound(currRound);
    const mapping = this.getRoundMapping(currRound);

    // Parallelize diff computation for better performance
    const infos = await Promise.all(
      roundOutputs.map(async (output) => {
        const location = output.location;
        const locationPath = getComparablePath(location);

        // Look up relationships using string keys (robust to FileLocation reconstruction)
        const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
        const prevLocation = mapping.prevToOutput.get(locationPath) ?? null;
        const originalLocation =
          mapping.originByOutput.get(locationPath) ?? null;

        // Determine effective diff base: prefer explicit base, fallback to original if different from current
        const isSameFile =
          originalLocation &&
          getComparablePath(originalLocation) === locationPath;
        const diffBaseLocation =
          baseLocation ??
          (originalLocation && !isSameFile ? originalLocation : null);

        const stats = await this.diffStatsManager.computeDiffStats(
          diffBaseLocation,
          location,
        );

        return {
          source: output.source,
          location,
          lineage: {
            // Track original file, what to compare against, and where diff is
            original: originalLocation,
            diffBase: diffBaseLocation,
            diffFile: null, // Set later when latexdiff is generated
          },
          diff: stats,
        };
      }),
    );

    return infos;
  }

  /**
   * Compute mapping metadata for a round on-demand.
   * Uses string keys (comparable paths) with FileLocation values for robust lookups.
   * All maps are indexed by OUTPUT path for efficient lineage tracking.
   */
  public getRoundMapping(currRound: number): RoundFileMapping {
    const currentData = this.rounds.get(currRound);
    const currentOutputs = currentData?.outputs ?? [];
    const currentLocations = currentOutputs.map((entry) => entry.location);

    // Create forward mapping: base → output
    const forwardBaseToOutput = createFileMapping(
      this.baseFiles,
      currentLocations,
      'contains',
    );

    // Reverse to: output path → base FileLocation (for efficient lookup in gatherOutputFileInfo)
    const baseToOutput = new Map<string, FileLocation>();
    for (const [basePath, outputLoc] of forwardBaseToOutput) {
      const baseLoc = this.baseFiles.find(
        (f) => getComparablePath(f) === basePath,
      );
      if (baseLoc) {
        baseToOutput.set(getComparablePath(outputLoc), baseLoc);
      }
    }

    const prevData = currRound > 0 ? this.rounds.get(currRound - 1) : undefined;
    const prevOutputs = prevData?.outputs ?? [];
    const prevLocations = prevOutputs.map((entry) => entry.location);

    // Create forward mapping: prev → current output
    const forwardPrevToOutput =
      currRound > 0
        ? createFileMapping(prevLocations, currentLocations, 'basename', true)
        : new Map<string, FileLocation>();

    // Reverse to: output path → prev FileLocation (for efficient lookup)
    const prevToOutput = new Map<string, FileLocation>();
    if (currRound > 0) {
      for (const [prevPath, outputLoc] of forwardPrevToOutput) {
        const prevLoc = prevLocations.find(
          (f) => getComparablePath(f) === prevPath,
        );
        if (prevLoc) {
          prevToOutput.set(getComparablePath(outputLoc), prevLoc);
        }
      }
    }

    // Map each output to its original base file by matching source name
    const originByOutput = new Map<string, FileLocation | undefined>();
    for (const entry of currentOutputs) {
      // Find the base file that matches this output's source name
      // Use exact basename matching (with or without extension for LaTeX compatibility)
      const matchingBase = this.baseFiles.find((baseLoc) => {
        const baseName = path.basename(
          baseLoc.kind !== 'external'
            ? baseLoc.relativePath
            : baseLoc.absolutePath,
        );
        const baseNameNoExt = path.parse(baseName).name;
        const sourceNoExt = path.parse(entry.source).name;

        return (
          baseName === entry.source ||
          baseNameNoExt === sourceNoExt ||
          baseNameNoExt === entry.source ||
          baseName === sourceNoExt
        );
      });

      const outputPath = getComparablePath(entry.location);
      originByOutput.set(outputPath, matchingBase);
    }

    return {
      baseToOutput,
      prevToOutput,
      originByOutput,
    };
  }

  public hydrateFromArtifacts(
    runId: string | null | undefined,
    rounds: Map<number, OutputFileInfo[]>,
  ): void {
    const loggerRunId = this.logger.withCurrentGroup((id) => id);
    const effectiveRunId = runId ?? loggerRunId ?? null;
    const normalizedCurrent = normalizeRunId(this.currentRunId);
    const normalizedTarget = normalizeRunId(effectiveRunId);
    this.logger.debug(
      `Hydrate outputs for runId=${normalizeRunId(runId)} loggerRunId=${normalizeRunId(loggerRunId)} current=${normalizedCurrent} target=${normalizedTarget}`,
      { messageType: MESSAGE_TYPES.INTERNAL },
    );
    if (normalizedTarget !== normalizedCurrent) {
      this.setActiveRun(effectiveRunId);
    }

    for (const [round, infos] of rounds.entries()) {
      if (infos.length > 0) {
        this.rounds.set(round, {
          outputs: infos,
          rawOutput: null,
          xmlSummary: {
            tagContents: {},
            documents: [],
            singleOutputFile: null,
            sourceLocation: null,
          },
        });
      }
    }
  }

  /**
   * Set output files for a round.
   * @param round The round number
   * @param outputs The output file infos
   */
  private setRoundOutputs(round: number, outputs: OutputFileInfo[]): void {
    const data = this.ensureRoundData(round);
    data.outputs = outputs;
  }

  public async validateExpectedOutputs(
    outputLocation: FileLocation,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void> {
    await this.withOutputStage(
      `Validate expected r${currRound}`,
      stage,
      async () => {
        const executionId = this.fileService.getExecutionId();
        const runId = this.getActiveRunId();
        const expected = this.agentConfig.outputFiles;
        if (!expected || expected.length === 0) {
          bus.emit('updateMissingOutputs', {
            stream: this.channel,
            runId,
            executionId,
            filesByRound: { [currRound]: [] },
          });
          this.logger.debug(
            `updateMissingOutputs emitted (no expected outputs) for round ${currRound} runId=${runId} executionId=${executionId ?? 'none'}`,
            { messageType: MESSAGE_TYPES.INTERNAL },
          );
          return;
        }

        // Use run-storage aware location resolution
        const checks = expected.map(async (file) => ({
          file,
          exists: await flexibleFS.exists(
            this.fileService.createLocation(file),
          ),
        }));
        const results = await Promise.all(checks);
        const missing = results.filter((r) => !r.exists).map((r) => r.file);

        if (missing.length > 0) {
          const xmlLocation = outputLocation;
          const xmlExists = await flexibleFS.exists(xmlLocation);

          const missingOutputsData = {
            missing,
            xmlFile: xmlExists ? xmlLocation.absolutePath : null,
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
          runId,
          executionId,
          filesByRound: { [currRound]: missing },
        });
        this.logger.debug(
          `updateMissingOutputs emitted with ${missing.length} missing for round ${currRound} runId=${runId} executionId=${executionId ?? 'none'}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
      },
    );
  }

  /**
   * Finalize processing for a conversation round.
   * Gathers file info, validates expected outputs and
   * emits an event with the collected files.
   */
  public async finalizeRound(
    outputFile: FileLocation,
    currRound: number,
    options: { endTurn: boolean; stage?: AgentLogStage },
  ): Promise<void> {
    const { endTurn, stage } = options;
    await this.withOutputStage(
      `Finalize r${currRound}`,
      stage,
      async (scope) => {
        const data = this.ensureRoundData(currRound);
        const rawLocation = data.rawOutput ?? outputFile;
        data.rawOutput = rawLocation;

        const fileInfos = await this.gatherOutputFileInfo(currRound);
        data.outputs = fileInfos;
        const executionId = this.fileService.getExecutionId();
        const runId = this.getActiveRunId();

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
          runId,
          executionId,
          filesByRound: { [currRound]: fileInfos },
        });
        this.logger.debug(
          `addOutputFiles emitted for round ${currRound} runId=${runId} executionId=${executionId ?? 'none'} files=${fileInfos.length}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );

        for (const info of fileInfos) {
          const filePath = info.location.absolutePath;
          if (this.openedOutputs.has(filePath)) {
            continue;
          }

          try {
            await openBuildDisplayIfTex(info.location, { preserveFocus: true });
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
    outputLocation: FileLocation,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<void> {
    await this.withOutputStage(
      `Process files r${currRound}`,
      stage,
      async (scope) => {
        this.ensureRound(currRound);
        await this.prepareRunWorkspaceIfNeeded();

        const data = this.ensureRoundData(currRound);
        const rawLocation = data.rawOutput ?? outputLocation;
        data.rawOutput = rawLocation;
        const rawPath = rawLocation.absolutePath;
        const executionId = this.fileService.getExecutionId();
        const runId = this.getActiveRunId();

        const handleMultipleOutputs = async () => {
          this.logger.debug(
            `Processing multiple outputs for ${outputLocation.absolutePath}; outputFiles: ${this.agentConfig.outputFiles}`,
          );

          try {
            const processedPairs =
              await this.xmlManager.processMultipleXmlOutputs(outputLocation);

            if (processedPairs && processedPairs.length > 0) {
              await this.indentLatexFiles(
                processedPairs.map((p) => p.location),
              );
              this.logger.debug(
                `Indented multiple output files: ${processedPairs.map((p) => p.location.absolutePath).join(',')}`,
              );

              if (this.baseFiles && this.baseFiles.length > 0) {
                await replaceInputCommands(
                  this.baseFiles,
                  processedPairs.map((p) => p.location),
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
              `No processed files were generated from ${outputLocation.absolutePath}`,
            );
            this.setRoundOutputs(currRound, []);
            await this.cleanupLatexBackups(rawLocation);
            await this.captureXmlSummary(currRound, rawLocation, [], scope);
          } catch (err) {
            this.logger.debug(
              `Error processing output files: ${toErrorMessage(err)}`,
              { messageType: MESSAGE_TYPES.INTERNAL },
            );
            this.setRoundOutputs(currRound, []);
            await this.cleanupLatexBackups(rawLocation);
            await this.captureXmlSummary(currRound, rawLocation, [], scope);
          }
        };

        const handleSingleOutput = async () => {
          this.logger.debug(
            `Processing single output for ${outputLocation.absolutePath}`,
          );

          try {
            const processedLocation = rawLocation ?? outputLocation;
            let processed: OutputFileInfo = {
              source: path.basename(outputLocation.absolutePath),
              location: processedLocation,
              lineage: null,
              diff: null,
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
                await this.xmlManager.processSingleXmlOutput(outputLocation);
            }

            const hasProcessedPath = Boolean(
              processed && processed.location.absolutePath,
            );

            if (hasProcessedPath && processed.location) {
              await this.indentLatexFile(processed.location);
              this.logger.debug(
                `Indented single output file: ${processed.location.absolutePath}`,
              );
            }

            const processedFiles = hasProcessedPath ? [processed] : [];

            if (hasProcessedPath) {
              if (this.baseFiles && this.baseFiles.length > 0) {
                await replaceInputCommands(
                  this.baseFiles,
                  processedFiles.map((entry) => entry.location),
                  this.logger,
                );
              }

              this.setRoundOutputs(currRound, processedFiles);
            } else {
              this.logger.debug(
                `No processed file was generated from ${outputLocation.absolutePath}`,
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
              { messageType: MESSAGE_TYPES.INTERNAL },
            );
            const missingOutputsData = {
              missing: [],
              xmlFile: outputLocation.absolutePath,
              documentTag: this.agentSetting.documentTag,
            };
            this.logger.missingOutputs(missingOutputsData);
            bus.emit('updateMissingOutputs', {
              stream: this.channel,
              runId,
              executionId,
              filesByRound: { [currRound]: [] },
            });
            this.setRoundOutputs(currRound, []);
            await this.captureXmlSummary(currRound, rawLocation, [], scope);
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

  public async getRoundArtifacts(round: number): Promise<RoundOutput> {
    const data = this.rounds.get(round);
    let fileInfos = data?.outputs;
    if (!fileInfos) {
      fileInfos = await this.gatherOutputFileInfo(round);
      const updatedData = this.ensureRoundData(round);
      updatedData.outputs = fileInfos;
    }

    const roundData = this.rounds.get(round);
    return {
      round,
      rawOutput: roundData?.rawOutput ?? null,
      outputs: fileInfos,
      xmlSummary: roundData?.xmlSummary ?? this.getRoundXmlSummary(round),
    };
  }

  public getRoundXmlSummary(round: number): OutputXmlSummary {
    const data = this.rounds.get(round);
    return (
      data?.xmlSummary ?? {
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
    processed: OutputFileInfo[],
    stage?: AgentLogStage,
  ): Promise<void> {
    const run = async () => {
      const singleFile =
        processed.length === 1 ? processed[0].location.absolutePath : null;
      const data = this.ensureRoundData(round);
      const sourceLocation = rawOutput ?? data.rawOutput ?? null;

      if (!rawOutput?.absolutePath) {
        data.xmlSummary = {
          tagContents: {},
          documents: [],
          singleOutputFile: singleFile,
          sourceLocation,
        };
        return;
      }

      try {
        const rawContent = await flexibleFS.read(rawOutput);
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

        data.xmlSummary = {
          tagContents,
          documents,
          singleOutputFile: singleFile,
          sourceLocation,
        };
      } catch (error) {
        this.logger.debug(
          `Failed to collect XML summary for round ${round}: ${toErrorMessage(error)}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
        data.xmlSummary = {
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
