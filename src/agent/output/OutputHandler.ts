import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { StorageKey } from '@agent/types/IdentifierTypes';
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

import { DiffStatsManager } from './DiffStatsManager';
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
  public logId: number;
  private rounds: Map<number, RoundData>;

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
  private readonly lineageCalculator: FileLineageCalculator;
  private diffStatsManager: DiffStatsManager;
  private readonly openedOutputs: Set<string>;
  private readonly fileService: TaskRunFileService;
  private readonly executionId: string;
  private _storageKey: StorageKey | null;
  private runPreparation: Promise<void> | null;
  private readonly fileProcessor: OutputFileProcessor;

  constructor(
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
    logId: number,
    baseFiles: FileLocation[],
    logger: AgentLogger,
    fileService: TaskRunFileService,
    executionId: string,
  ) {
    this.agentSetting = requireWorkflowSetting(agentSetting);
    this.agentConfig = agentConfig;
    this.logId = logId;
    this.rounds = new Map();
    this.baseFiles = baseFiles;
    this.logger = logger;
    this.channel = this.logger.channelId;
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
      this.channel,
      this.fileService,
    );
    this.lineageCalculator = new FileLineageCalculator(this.baseFiles);
    this.diffStatsManager = new DiffStatsManager();
    this.openedOutputs = new Set();
    this._storageKey = null;
    this.runPreparation = null;

    this.fileProcessor = new OutputFileProcessor({
      agentSetting: this.agentSetting,
      baseFiles: this.baseFiles,
      channel: this.channel,
      logger: this.logger,
      xmlManager: this.xmlManager,
      setRoundOutputs: this.setRoundOutputs.bind(this),
      ensureRoundData: this.ensureRoundData.bind(this),
    });
  }

  private collectRunSnapshotFiles(): FileLocation[] {
    return this.baseFiles.filter((candidate) => candidate !== null);
  }

  private collectRunSupportFiles(): FileLocation[] {
    const extras = new Map<string, FileLocation>();
    const add = (value?: string | FileLocation | null) => {
      if (!value) return;
      const location =
        typeof value === 'string' ? pathToLocation(value) : value;
      extras.set(getComparablePath(location), location);
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

    return [...extras.values()];
  }

  public setActiveRun(storageKey: StorageKey): void {
    this.fileService.updateRunContext(this.executionId);

    if (storageKey === this._storageKey) return;

    this._storageKey = storageKey;
    this.openedOutputs.clear();

    const snapshotTargets = this.collectRunSnapshotFiles();
    const supportFiles = this.collectRunSupportFiles();
    this.runPreparation = this.fileService.prepareRunWorkspace(
      snapshotTargets,
      { linkFiles: supportFiles },
    );
  }

  private getStorageKey(): StorageKey {
    return this._storageKey ?? normalizeRunId(null);
  }

  private createStoragePayload(): {
    storageKey: StorageKey;
    executionId: string | undefined;
  } {
    return {
      storageKey: this.getStorageKey(),
      executionId: this.executionId,
    };
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

  public async gatherOutputFileInfo(
    currRound: number,
  ): Promise<OutputFileInfo[]> {
    const roundOutputs = this.ensureRound(currRound);
    const mapping = this.getRoundMapping(currRound);

    const infos = await Promise.all(
      roundOutputs.map(async (output) => {
        const location = output.location;
        const locationPath = getComparablePath(location);

        const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
        const originalLocation =
          mapping.originByOutput.get(locationPath) ?? null;

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
        const storagePayload = this.createStoragePayload();
        const expected = this.agentConfig.outputFiles;
        if (!expected || expected.length === 0) {
          bus.emit('updateMissingOutputs', {
            stream: this.channel,
            ...storagePayload,
            filesByRound: { [currRound]: [] },
          });
          this.logger.debug(
            `updateMissingOutputs emitted (no expected outputs) for round ${currRound} storageKey=${storagePayload.storageKey}`,
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
          ...storagePayload,
          filesByRound: { [currRound]: missing },
        });
        this.logger.debug(
          `updateMissingOutputs emitted with ${missing.length} missing for round ${currRound} storageKey=${storagePayload.storageKey}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
      },
    );
  }

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
        const storagePayload = this.createStoragePayload();

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
          ...storagePayload,
          filesByRound: { [currRound]: fileInfos },
        });
        this.logger.debug(
          `addOutputFiles emitted for round ${currRound} storageKey=${storagePayload.storageKey} files=${fileInfos.length}`,
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
        const rawLocation = data.rawOutput ?? outputLocation;
        data.rawOutput = rawLocation;

        if (
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

        const storagePayload = this.createStoragePayload();
        await this.fileProcessor.processSingleOutput(
          outputLocation,
          currRound,
          rawLocation,
          storagePayload,
          scope,
        );
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
}
