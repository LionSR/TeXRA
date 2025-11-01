// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentCategory,
  AgentSetting,
  AgentType,
} from '@agent/core/AgentDataclass';
import { OutputHandler } from '@agent/output';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import { createAgentRunContext } from '@agent/runtime/AgentRunContext';
import type { AgentRunContext } from '@agent/runtime/AgentRunContext';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

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

  const baseConfig: AgentConfig = {
    model: 'test',
    agent: 'agent',
    instruction: '',
    useMultipleOutputs: false,
    inputFile: 'input.tex',
    inputFiles: null,
    referenceFile: null,
    referenceFiles: null,
    auxiliaryFile: null,
    auxiliaryFiles: null,
    mediaFile: null,
    mediaFiles: null,
    outputFiles: null,
    editedFile: null,
    toolConfig: {
      autoExtractFigure: false,
      autoExtractTikzFigure: false,
      attachTeXCount: false,
      attachDiagnostics: false,
      autoCompileInputPdf: false,
    },
  };

  function createContext(name: string): AgentRunContext {
    const context = createAgentRunContext({
      streamTabId: name as StreamTabId,
      executionId: undefined,
      session: {
        agentType: AgentType.CoT,
        agentCategory: AgentCategory.Workflow,
      },
      agentName: 'agent',
      model: baseConfig.model,
      inputFile: baseConfig.inputFile,
    });
    const noop = () => {};
    const logger = context.logger as any;
    logger.debug = noop;
    logger.info = noop;
    logger.warn = noop;
    logger.error = noop;
    logger.latexDiff = noop;
    return context;
  }

  it('uses shared base mapping for round diffs', async () => {
    const context = createContext('latexdiff-round');
    const baseFiles = [path.join('workspace', 'chapter.tex')];
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      baseFiles,
      context,
    );

    handler.outputFiles[0] = [path.join('workspace', 'chapter_r0.tex')];
    handler.outputMappings[0] = [
      {
        source: path.join('workspace', 'chapter_r0.tex'),
        path: path.join('workspace', 'chapter_r0.tex'),
      },
    ];

    const mapping = handler.getRoundMapping(0);

    const roundPairs: Array<{ base: string; revised: string; round: number }> =
      [];
    const aggregated: unknown[][] = [];

    const testContext = createContext('latexdiff-round-manager');
    (testContext.logger as any).latexDiff = (entries: unknown[]) =>
      aggregated.push(entries);

    const manager = new LatexDiffManager(
      handler.agentSetting,
      handler.outputFiles,
      baseFiles,
      testContext.logger,
      testContext.streamTabId,
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

    await manager.handleLatexdiffofOutput(0, mapping, 'group');

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
    const context = createContext('latexdiff-between');
    const baseFiles = [path.join('workspace', 'paper.tex')];
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      baseFiles,
      context,
    );

    handler.outputFiles[0] = [path.join('workspace', 'paper_r0.tex')];
    handler.outputMappings[0] = [
      {
        source: path.join('workspace', 'paper_r0.tex'),
        path: path.join('workspace', 'paper_r0.tex'),
      },
    ];
    handler.outputFiles[1] = [path.join('workspace', 'paper_r1.tex')];
    handler.outputMappings[1] = [
      {
        source: path.join('workspace', 'paper_r1.tex'),
        path: path.join('workspace', 'paper_r1.tex'),
      },
    ];

    const mapping = handler.getRoundMapping(1);

    const roundPairs: Array<{ base: string; revised: string; round: number }> =
      [];
    const betweenPairs: Array<{ previous: string; current: string }> = [];

    const testContext = createContext('latexdiff-between-manager');

    const manager = new LatexDiffManager(
      handler.agentSetting,
      handler.outputFiles,
      baseFiles,
      testContext.logger,
      testContext.streamTabId,
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

    await manager.handleLatexdiffofOutput(1, mapping, 'group');

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
