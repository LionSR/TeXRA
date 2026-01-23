// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { StorageKey } from '@agent/types/IdentifierTypes';
import type { DiffStats } from '@agent/types/DiffTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import {
  TaskRunFileService,
  flexibleFS,
  pathToLocation,
  getComparablePath,
  type FileLocation,
} from '@utils/files';
import { bus } from '@eventBus/ProgressEventBus';
import { countLines } from '@utils/text/stringUtils';
import { FileLineageCalculator } from './FileLineageCalculator';
import { LatexDiffManager } from './LatexDiffManager';
import { OutputFileProcessor } from './OutputFileProcessor';
import { XmlOutputManager } from './XmlOutputManager';

import type { IOutputHandler } from './IOutputHandler';
import type {
  OutputFileInfo,
  OutputXmlSummary,
  RoundFileMapping,
  RoundOutput,
} from './types';

interface RoundData {
  outputs: OutputFileInfo[];
  rawOutput: FileLocation | null;
  xmlSummary: OutputXmlSummary;
}

/** Handles output file processing and validation for agent responses. */
export class OutputHandler implements IOutputHandler {
  public agentSetting: AgentWorkflowSetting;
  public agentConfig: AgentConfig;
  private rounds: Map<number, RoundData>;

  public get outputFiles(): { [key: number]: OutputFileInfo[] } {
    return Object.fromEntries(
      [...this.rounds].map(([round, data]) => [round, data.outputs]),
    );
  }

  public baseFiles: FileLocation[];
  protected logger: AgentLogger;
  protected streamId: string;
  public readonly xmlManager: XmlOutputManager;
  public readonly diffManager: LatexDiffManager;
  private readonly lineageCalculator: FileLineageCalculator;
  private readonly openedOutputs: Set<string>;
  private readonly fileService: TaskRunFileService;
  private readonly executionId: string;
  private _storageKey: StorageKey | null;
  private runPreparation: Promise<void> | null;
  private readonly fileProcessor: OutputFileProcessor;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    baseFiles: FileLocation[],
    logger: AgentLogger,
    fileService: TaskRunFileService,
    executionId: string,
  ) {
    this.agentSetting = requireWorkflowSetting(agentSetting);
    this.agentConfig = agentConfig;
    this.rounds = new Map();
    this.baseFiles = baseFiles;
    this.logger = logger;
    this.streamId = this.logger.streamId;
    this.fileService = fileService;
    this.executionId = executionId;

    this.xmlManager = new XmlOutputManager(
      this.agentSetting,
      this.agentConfig,
      this.logger,
      this.fileService,
    );
    this.diffManager = new LatexDiffManager(
      this.agentSetting,
      () => this.outputFiles,
      this.baseFiles,
      this.logger,
      this.streamId,
      this.fileService,
    );
    this.lineageCalculator = new FileLineageCalculator(this.baseFiles);
    this.openedOutputs = new Set();
    this._storageKey = null;
    this.runPreparation = null;

    this.fileProcessor = new OutputFileProcessor({
      agentSetting: this.agentSetting,
      baseFiles: this.baseFiles,
      streamId: this.streamId,
      logger: this.logger,
      xmlManager: this.xmlManager,
      setRoundOutputs: this.setRoundOutputs.bind(this),
      ensureRoundData: this.ensureRoundData.bind(this),
    });
  }

  private collectRunSupportFiles(): FileLocation[] {
    const extras = new Map<string, FileLocation>();
    const cfg = this.agentConfig;

    // Collect all file paths from config
    const allPaths = [
      cfg.referenceFile,
      ...cfg.referenceFiles,
      cfg.auxiliaryFile,
      ...cfg.auxiliaryFiles,
      cfg.mediaFile,
      ...cfg.mediaFiles,
      cfg.inputFile,
      ...cfg.inputFiles,
    ];

    // Deduplicate by comparable path
    for (const value of allPaths) {
      if (!value) continue;
      const location =
        typeof value === 'string' ? pathToLocation(value) : value;
      extras.set(getComparablePath(location), location);
    }

    return [...extras.values()];
  }

  public setActiveRun(storageKey: StorageKey): void {
    this.fileService.updateRunContext(this.executionId);

    if (storageKey === this._storageKey) return;

    this._storageKey = storageKey;
    this.openedOutputs.clear();

    const supportFiles = this.collectRunSupportFiles();
    this.runPreparation = this.fileService.prepareRunWorkspace(this.baseFiles, {
      linkFiles: supportFiles,
    });
  }

  private getStorageKey(): StorageKey {
    return this._storageKey ?? normalizeRunId(null);
  }

  private async prepareRunWorkspaceIfNeeded(): Promise<void> {
    if (!this.runPreparation) return;

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

  public async ensureXmlStructure(
    fileLocation: FileLocation,
    documentTag: string,
  ): Promise<void> {
    await this.xmlManager.ensureCorrectXmlStructure(fileLocation, documentTag);
  }

  private setRoundOutputs(round: number, outputs: OutputFileInfo[]): void {
    const data = this.ensureRoundData(round);
    data.outputs = outputs;
  }

  private async computeDiffStats(
    baseLocation: FileLocation | null,
    outputLocation: FileLocation,
  ): Promise<DiffStats> {
    try {
      if (!baseLocation) {
        const outContent = await flexibleFS.read(outputLocation);
        const added = countLines(outContent);
        return { added };
      }

      const [baseContent, outContent] = await Promise.all([
        flexibleFS.read(baseLocation),
        flexibleFS.read(outputLocation),
      ]);

      const dmp = new diff_match_patch();
      const diffs = dmp.diff_main(baseContent, outContent);
      let added = 0;
      let removed = 0;
      for (const [op, text] of diffs) {
        if (op === 1) {
          added += countLines(text);
        } else if (op === -1) {
          removed += countLines(text);
        }
      }
      return { added, removed };
    } catch (_error) {
      // File read errors are expected (e.g., file not found during processing)
      // Return empty stats rather than propagating the error
      return {};
    }
  }

  public async gatherOutputFileInfo(
    currRound: number,
    precomputedMapping?: RoundFileMapping,
  ): Promise<OutputFileInfo[]> {
    const roundOutputs = this.ensureRound(currRound);
    const mapping = precomputedMapping ?? this.getRoundMapping(currRound);

    const infos = await Promise.all(
      roundOutputs.map(async (output) => {
        const location = output.location;
        const locationPath = getComparablePath(location);

        const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
        const originalLocation =
          mapping.originByOutput.get(locationPath) ?? null;

        // Use baseLocation for diff, or originalLocation if it's a different file
        const originalIsDifferentFile =
          originalLocation &&
          getComparablePath(originalLocation) !== locationPath;
        let diffBaseLocation = baseLocation;
        if (!diffBaseLocation && originalIsDifferentFile) {
          diffBaseLocation = originalLocation;
        }

        const stats = await this.computeDiffStats(diffBaseLocation, location);

        return {
          source: output.source,
          round: output.round,
          location,
          lineage: {
            original: originalLocation,
            diffBase: diffBaseLocation,
            diffFile: null,
          },
          diff: stats,
        };
      }),
    );

    return infos;
  }

  public getRoundMapping(currRound: number): RoundFileMapping {
    const currentData = this.rounds.get(currRound);
    const currentOutputs = currentData?.outputs ?? [];
    const prevData = currRound > 0 ? this.rounds.get(currRound - 1) : undefined;
    const prevOutputs = prevData?.outputs ?? [];

    return this.lineageCalculator.calculateMapping(currentOutputs, prevOutputs);
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
        const storageKey = this.getStorageKey();
        const expected = this.agentConfig.outputFiles;
        if (!expected || expected.length === 0) {
          bus.emit('updateMissingOutputs', {
            streamId: this.streamId,
            storageKey,
            filesByRound: { [currRound]: [] },
          });
          this.logger.debug(
            `updateMissingOutputs emitted (no expected outputs) for round ${currRound} storageKey=${storageKey}`,
            { messageType: MESSAGE_TYPES.INTERNAL },
          );
          return;
        }

        const checks = expected.map(async (file) => ({
          file,
          exists: await flexibleFS.exists(
            this.fileService.createLocation(file),
          ),
        }));
        const results = await Promise.all(checks);
        const missing = results.filter((r) => !r.exists).map((r) => r.file);

        if (missing.length > 0) {
          const xmlExists = await flexibleFS.exists(outputLocation);

          this.logger.missingOutputs({
            missing,
            xmlFile: xmlExists ? outputLocation.absolutePath : null,
            documentTag: this.agentSetting.documentTag,
          });
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
          streamId: this.streamId,
          storageKey,
          filesByRound: { [currRound]: missing },
        });
        this.logger.debug(
          `updateMissingOutputs emitted with ${missing.length} missing for round ${currRound} storageKey=${storageKey}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
      },
    );
  }

  public async finalizeRound(
    outputFile: FileLocation,
    currRound: number,
    options: {
      endTurn: boolean;
      stage?: AgentLogStage;
      mapping?: RoundFileMapping;
    },
  ): Promise<void> {
    const { endTurn, stage, mapping } = options;
    await this.withOutputStage(
      `Finalize r${currRound}`,
      stage,
      async (scope) => {
        const data = this.ensureRoundData(currRound);
        data.rawOutput ??= outputFile;

        const fileInfos = await this.gatherOutputFileInfo(currRound, mapping);
        data.outputs = fileInfos;
        const storageKey = this.getStorageKey();

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
          streamId: this.streamId,
          storageKey,
          filesByRound: { [currRound]: fileInfos },
        });
        this.logger.debug(
          `addOutputFiles emitted for round ${currRound} storageKey=${storageKey} files=${fileInfos.length}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );

        for (const info of fileInfos) {
          const filePath = info.location.absolutePath;
          if (this.openedOutputs.has(filePath)) continue;

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
        data.rawOutput ??= outputLocation;
        const rawLocation = data.rawOutput;

        // Route to multiple outputs only when explicitly enabled AND files are specified.
        // This ensures agents without _multiple variants use single output processing
        // even if output files were specified in the config.
        if (
          this.agentConfig.useMultipleOutputs &&
          Array.isArray(this.agentConfig.outputFiles) &&
          this.agentConfig.outputFiles.length > 0
        ) {
          await this.fileProcessor.processMultipleOutputs(
            outputLocation,
            currRound,
            rawLocation,
            scope,
          );
          return;
        }

        await this.fileProcessor.processSingleOutput(
          outputLocation,
          currRound,
          rawLocation,
          this.getStorageKey(),
          scope,
        );
      },
    );
  }

  public async getRoundArtifacts(round: number): Promise<RoundOutput> {
    const data = this.ensureRoundData(round);

    if (data.outputs.length === 0) {
      data.outputs = await this.gatherOutputFileInfo(round);
    }

    return {
      round,
      rawOutput: data.rawOutput,
      outputs: data.outputs,
      xmlSummary: data.xmlSummary,
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
}
