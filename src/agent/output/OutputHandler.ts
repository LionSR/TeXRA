import { diff_match_patch } from 'diff-match-patch';
import { z } from 'zod';

import {
  FileLocationSchema,
  MESSAGE_TYPES,
  OutputFileInfoSchema,
  OutputXmlSummarySchema,
  type FileLocation,
  type OutputFileInfo,
  type RoundOutput,
  type StorageKey,
} from '@shared/schemas';
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentWorkflowSetting,
  requireWorkflowSetting,
} from '@agent/core/AgentDataclass';
import type { DiffStats } from '@agent/types/DiffTypes';
import { normalizeRunId } from '@common/constants/runIds';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import { AgentLogger, type AgentLogStage } from '@logger/AgentLogger';
import {
  TaskRunFileService,
  flexibleFS,
  getComparablePath,
  pathToLocation,
} from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

import { FileLineageCalculator } from './FileLineageCalculator';
import { LatexDiffManager } from './LatexDiffManager';
import { OutputFileProcessor } from './OutputFileProcessor';
import { XmlOutputManager } from './XmlOutputManager';
import type {
  IOutputHandler,
  FinalizeRoundResult,
  ValidationResult,
} from './IOutputHandler';
import type { RoundFileMapping } from './types';

const RoundDataSchema = z.object({
  outputs: OutputFileInfoSchema.array().prefault(() => []),
  rawOutput: FileLocationSchema.nullable().prefault(null),
  xmlSummary: OutputXmlSummarySchema.prefault(() => ({})),
});

type RoundData = z.infer<typeof RoundDataSchema>;

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
      data = RoundDataSchema.parse({});
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
    } catch {
      return {};
    }
  }

  public async gatherOutputFileInfo(
    currRound: number,
    precomputedMapping?: RoundFileMapping,
  ): Promise<OutputFileInfo[]> {
    const roundOutputs = this.ensureRound(currRound);
    const mapping = precomputedMapping ?? this.getRoundMapping(currRound);

    return Promise.all(
      roundOutputs.map(async (output) => {
        const location = output.location;
        const locationPath = getComparablePath(location);

        const baseLocation = mapping.baseToOutput.get(locationPath) ?? null;
        const originalLocation =
          mapping.originByOutput.get(locationPath) ?? null;
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
  }

  public getRoundMapping(currRound: number): RoundFileMapping {
    const currentOutputs = this.rounds.get(currRound)?.outputs ?? [];
    const prevOutputs =
      (currRound > 0 ? this.rounds.get(currRound - 1)?.outputs : undefined) ??
      [];

    return this.lineageCalculator.calculateMapping(currentOutputs, prevOutputs);
  }

  public async validateExpectedOutputs(
    outputLocation: FileLocation,
    currRound: number,
    stage?: AgentLogStage,
  ): Promise<ValidationResult> {
    return this.withOutputStage(
      `Validate expected r${currRound}`,
      stage,
      async (): Promise<ValidationResult> => {
        const storageKey = this.getStorageKey();
        const expected = this.agentConfig.outputFiles;
        if (!expected || expected.length === 0) {
          this.logger.debug(
            `No expected outputs for round ${currRound} storageKey=${storageKey}`,
            { messageType: MESSAGE_TYPES.INTERNAL },
          );
          return { storageKey, currRound, missing: [], xmlExists: false };
        }

        const checks = expected.map(async (file) => ({
          file,
          exists: await flexibleFS.exists(
            this.fileService.createLocation(file),
          ),
        }));
        const results = await Promise.all(checks);
        const missing = results.filter((r) => !r.exists).map((r) => r.file);
        const xmlExists = await flexibleFS.exists(outputLocation);

        if (missing.length > 0) {
          this.logger.missingOutputs({
            missing,
            xmlFile: xmlExists ? outputLocation.absolutePath : null,
            documentTag: this.agentSetting.documentTag,
          });
          this.logger.debug(
            `Missing expected outputs for round ${currRound}: ${missing.join(', ')}`,
          );
        } else {
          this.logger.debug(
            `All expected outputs exist after round ${currRound}`,
          );
        }

        return { storageKey, currRound, missing, xmlExists };
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
  ): Promise<FinalizeRoundResult> {
    return this.withOutputStage(
      `Finalize r${currRound}`,
      options.stage,
      async (scope): Promise<FinalizeRoundResult> => {
        const data = this.ensureRoundData(currRound);
        data.rawOutput ??= outputFile;

        const fileInfos = await this.gatherOutputFileInfo(
          currRound,
          options.mapping,
        );
        data.outputs = fileInfos;
        const storageKey = this.getStorageKey();

        // Collect file paths that haven't been opened yet
        const filesToOpen: FileLocation[] = [];
        for (const info of fileInfos) {
          const filePath = info.location.absolutePath;
          if (!this.openedOutputs.has(filePath)) {
            filesToOpen.push(info.location);
            this.openedOutputs.add(filePath);
          }
        }

        this.logger.debug(
          `Finalized round ${currRound} storageKey=${storageKey} files=${fileInfos.length}`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );

        return {
          storageKey,
          currRound,
          fileInfos,
          filesToOpen,
          outputFile,
          endTurn: options.endTurn,
          stage: scope,
        };
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
      async () => {
        await this.prepareRunWorkspaceIfNeeded();

        const data = this.ensureRoundData(currRound);
        data.rawOutput ??= outputLocation;
        const rawLocation = data.rawOutput;

        const hasMultipleOutputs =
          this.agentConfig.useMultipleOutputs &&
          this.agentConfig.outputFiles?.length > 0;

        if (hasMultipleOutputs) {
          await this.fileProcessor.processMultipleOutputs(
            outputLocation,
            currRound,
            rawLocation,
          );
          return;
        }

        await this.fileProcessor.processSingleOutput(
          outputLocation,
          currRound,
          rawLocation,
          this.getStorageKey(),
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
}
