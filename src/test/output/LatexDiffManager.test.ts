// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentCategory,
  AgentSetting,
  AgentType,
} from '@agent/core/AgentDataclass';
import { OutputHandler } from '@agent/output';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import type { NamedOutputFile } from '@agent/output/types';
import { TaskRunFileService } from '@utils/files';
import type { FileLocation } from '@utils/files/taskRunStorage';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

describe('LatexDiffManager mapping reuse', () => {
  const baseSetting: AgentSetting = {
    agentType: AgentType.CoT,
    agentCategory: AgentCategory.Workflow,
    documentTag: 'document',
    temperature: 0,
    isRewrite: true,
    rounds: 3,
    prefills: [],
    outputExt: 'tex',
    endTag: '</latex_document>',
    requiredFiles: {},
    requiredFilesInternal: {},
    defaultOutputFiles: [],
    isMultipleOutput: false,
    filePatternsContain: [],
    tools: [],
  };

  const baseConfig: AgentConfig = parseAgentConfig({
    model: 'test',
    agent: 'agent',
    instruction: '',
    useMultipleOutputs: false,
    inputFile: 'input.tex',
    toolConfig: {
      autoExtractFigure: false,
      autoExtractTikzFigure: false,
      attachTeXCount: false,
      attachDiagnostics: false,
      autoCompileInputPdf: false,
    },
  });

  function createLogger(): AgentLogger {
    const logger = new AgentLogger('LatexDiffManagerTest');
    const noop = () => {};
    (logger as any).debug = noop;
    (logger as any).info = noop;
    (logger as any).warn = noop;
    (logger as any).error = noop;
    (logger as any).latexDiff = noop;
    return logger;
  }

  function makeLocation(absolutePath: string): FileLocation {
    const workspacePrefix = `workspace${path.sep}`;
    const relative = absolutePath.startsWith(workspacePrefix)
      ? absolutePath.slice(workspacePrefix.length)
      : absolutePath;
    return {
      absolutePath,
      scope: 'workspace',
      relativePath: relative,
      relativeScope: 'workspace',
      workspace: {
        absolutePath,
        relativePath: relative,
      },
      runStorage: null,
    };
  }

  function createNamedOutput(
    filePath: string,
    source: string = filePath,
  ): NamedOutputFile {
    return {
      source,
      path: filePath,
      relativePath: filePath,
      location: makeLocation(filePath),
    };
  }

  it('uses shared base mapping for round diffs', async () => {
    const logger = createLogger();
    const baseFiles = [path.join('workspace', 'chapter.tex')];
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      baseFiles,
      logger,
      new TaskRunFileService(),
    );

    handler.outputFiles[0] = [path.join('workspace', 'chapter_r0.tex')];
    handler.outputMappings[0] = [
      createNamedOutput(path.join('workspace', 'chapter_r0.tex')),
    ];

    const mapping = handler.getRoundMapping(0);

    const roundPairs: Array<{ base: string; revised: string; round: number }> =
      [];
    const aggregated: unknown[][] = [];

    const testLogger = createLogger();
    (testLogger as any).latexDiff = (entries: unknown[]) =>
      aggregated.push(entries);

    const manager = new LatexDiffManager(
      handler.agentSetting,
      handler.outputFiles,
      baseFiles,
      testLogger,
      'channel',
      new TaskRunFileService(),
      {
        checkToolInstalled: async () => true,
        compileLatex2Pdf: async () => true,
        getConfig: <T>(_: string, defaultValue?: T) => defaultValue as T,
      },
    );

    (manager as any).latexdiffService = {
      runDiffForRound: async (base: string, revised: string, round: number) => {
        roundPairs.push({ base, revised, round });
        return { success: true };
      },
      runDiffBetweenRounds: async () => ({ success: true }),
    };

    await manager.handleLatexdiffofOutput(0, mapping);

    assert.deepEqual(roundPairs, [
      {
        base: path.join('workspace', 'chapter.tex'),
        revised: path.join('workspace', 'chapter_r0.tex'),
        round: 0,
      },
    ]);
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0].length, 1);
  });

  it('uses shared previous mapping for between-round diffs', async () => {
    const logger = createLogger();
    const baseFiles = [path.join('workspace', 'paper.tex')];
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      baseFiles,
      logger,
      new TaskRunFileService(),
    );

    handler.outputFiles[0] = [path.join('workspace', 'paper_r0.tex')];
    handler.outputMappings[0] = [
      createNamedOutput(path.join('workspace', 'paper_r0.tex')),
    ];
    handler.outputFiles[1] = [path.join('workspace', 'paper_r1.tex')];
    handler.outputMappings[1] = [
      createNamedOutput(path.join('workspace', 'paper_r1.tex')),
    ];

    const mapping = handler.getRoundMapping(1);

    const roundPairs: Array<{ base: string; revised: string; round: number }> =
      [];
    const betweenPairs: Array<{ previous: string; current: string }> = [];

    const testLogger = createLogger();

    const manager = new LatexDiffManager(
      handler.agentSetting,
      handler.outputFiles,
      baseFiles,
      testLogger,
      'channel',
      new TaskRunFileService(),
      {
        checkToolInstalled: async () => true,
        compileLatex2Pdf: async () => true,
        getConfig: <T>(key: string, defaultValue?: T) =>
          key === 'latexdiff.generateBetweenRoundDiffs'
            ? (true as T)
            : (defaultValue as T),
      },
    );

    (manager as any).latexdiffService = {
      runDiffForRound: async (base: string, revised: string, round: number) => {
        roundPairs.push({ base, revised, round });
        return { success: true };
      },
      runDiffBetweenRounds: async (prev: string, curr: string) => {
        betweenPairs.push({ previous: prev, current: curr });
        return { success: true };
      },
    };

    await manager.handleLatexdiffofOutput(1, mapping);

    assert.deepEqual(roundPairs, [
      {
        base: path.join('workspace', 'paper.tex'),
        revised: path.join('workspace', 'paper_r1.tex'),
        round: 1,
      },
    ]);
    assert.deepEqual(betweenPairs, [
      {
        previous: path.join('workspace', 'paper_r0.tex'),
        current: path.join('workspace', 'paper_r1.tex'),
      },
    ]);
  });
});
