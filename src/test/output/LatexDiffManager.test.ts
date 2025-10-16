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

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import * as systemModule from '@utils/system';
import * as configModule from '@utils/config';
import * as texToolsModule from '@latex/texTools';

type CheckToolInstalled = typeof systemModule.checkToolInstalled;
type GetConfig = typeof configModule.getConfig;
type CompileLatex2Pdf = typeof texToolsModule.compileLatex2Pdf;

describe('LatexDiffManager.handleLatexdiffofOutput', () => {
  const originalCheckToolInstalled = systemModule.checkToolInstalled;
  const originalGetConfig = configModule.getConfig;
  const originalCompileLatex2Pdf = texToolsModule.compileLatex2Pdf;

  const createSetting = (): AgentSetting => ({
    agentType: AgentType.CoT,
    agentCategory: AgentCategory.Workflow,
    documentTag: 'document',
    temperature: 0,
    isRewrite: true,
    rounds: 2,
    prefills: [],
    outputExt: 'tex',
    endTag: '</latex_document>',
    requiredFiles: {},
    requiredFilesInternal: {},
    defaultOutputFiles: [],
    isMultipleOutput: false,
    filePatternsContain: [],
    tools: [],
  });

  const config: AgentConfig = {
    model: 'test',
    agent: 'a',
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

  afterEach(() => {
    (
      systemModule as { checkToolInstalled: CheckToolInstalled }
    ).checkToolInstalled = originalCheckToolInstalled;
    (configModule as { getConfig: GetConfig }).getConfig = originalGetConfig;
    (
      texToolsModule as { compileLatex2Pdf: CompileLatex2Pdf }
    ).compileLatex2Pdf = originalCompileLatex2Pdf;
  });

  it('executes round diffs using provided mapping', async () => {
    (
      systemModule as { checkToolInstalled: CheckToolInstalled }
    ).checkToolInstalled = async () => true;
    (configModule as { getConfig: GetConfig }).getConfig = (<T>() =>
      false as unknown as T) as GetConfig;

    const compileCalls: Array<{ diffPath: string; buildDir: string }> = [];
    (
      texToolsModule as { compileLatex2Pdf: CompileLatex2Pdf }
    ).compileLatex2Pdf = async (
      diffPath,
      _channel,
      buildDir,
      _preferLatexmk,
    ) => {
      compileCalls.push({ diffPath, buildDir: buildDir ?? '' });
      return true;
    };

    const baseFile = path.join('workspace', 'base', 'ch1.tex');
    const outputFile = path.join('workspace', 'output', 'ch1.tex');

    const handler = new OutputHandler(
      createSetting(),
      config,
      0,
      [baseFile],
      new AgentLogger('TestLatexDiffManager'),
    );
    handler.outputFiles[0] = [outputFile];
    handler.outputMappings[0] = [
      { source: path.join('workspace', 'xml', 'ch1.tex'), path: outputFile },
    ];

    const mapping = handler.getRoundFileMapping(0);

    const manager = new LatexDiffManager(
      handler.agentSetting,
      handler.outputFiles,
      handler.baseFiles,
      new AgentLogger('TestLatexDiffManager'),
      'test-channel',
    );

    const roundCalls: Array<{ base: string; revised: string; round: number }> =
      [];
    (manager as any).latexdiffService = {
      runDiffForRound: async (base: string, revised: string, round: number) => {
        roundCalls.push({ base, revised, round });
        return { success: true, diffFileName: 'diff.tex' } as const;
      },
      runDiffBetweenRounds: async () => {
        throw new assert.AssertionError({
          message: 'between-round diff should not execute',
        });
      },
    };

    await manager.handleLatexdiffofOutput(0, mapping);

    assert.deepStrictEqual(roundCalls, [
      { base: baseFile, revised: outputFile, round: 0 },
    ]);
    assert.deepStrictEqual(compileCalls, [
      {
        diffPath: path.join(path.dirname(baseFile), 'diff.tex'),
        buildDir: path.join('workspace', 'base', 'build'),
      },
    ]);
  });

  it('executes between-round diffs using shared mapping', async () => {
    (
      systemModule as { checkToolInstalled: CheckToolInstalled }
    ).checkToolInstalled = async () => true;
    (configModule as { getConfig: GetConfig }).getConfig = (<T>() =>
      true as unknown as T) as GetConfig;

    const compileCalls: Array<{ diffPath: string; buildDir: string }> = [];
    (
      texToolsModule as { compileLatex2Pdf: CompileLatex2Pdf }
    ).compileLatex2Pdf = async (
      diffPath,
      _channel,
      buildDir,
      _preferLatexmk,
    ) => {
      compileCalls.push({ diffPath, buildDir: buildDir ?? '' });
      return true;
    };

    const baseFile = path.join('workspace', 'base', 'ch2.tex');
    const prevOutput = path.join('workspace', 'round0', 'ch2.tex');
    const currOutput = path.join('workspace', 'round1', 'ch2.tex');

    const handler = new OutputHandler(
      createSetting(),
      config,
      0,
      [baseFile],
      new AgentLogger('TestLatexDiffManager'),
    );
    handler.agentSetting.isRewrite = false;
    handler.outputFiles[0] = [prevOutput];
    handler.outputMappings[0] = [
      {
        source: path.join('workspace', 'xml', 'round0', 'ch2.tex'),
        path: prevOutput,
      },
    ];
    handler.outputFiles[1] = [currOutput];
    handler.outputMappings[1] = [
      {
        source: path.join('workspace', 'xml', 'round1', 'ch2.tex'),
        path: currOutput,
      },
    ];

    const mapping = handler.getRoundFileMapping(1);

    const manager = new LatexDiffManager(
      handler.agentSetting,
      handler.outputFiles,
      handler.baseFiles,
      new AgentLogger('TestLatexDiffManager'),
      'test-channel',
    );

    const roundCalls: Array<{ base: string; revised: string; round: number }> =
      [];
    const betweenCalls: Array<{ prev: string; curr: string }> = [];
    (manager as any).latexdiffService = {
      runDiffForRound: async (base: string, revised: string, round: number) => {
        roundCalls.push({ base, revised, round });
        return { success: true, diffFileName: 'round.tex' } as const;
      },
      runDiffBetweenRounds: async (prev: string, curr: string) => {
        betweenCalls.push({ prev, curr });
        return { success: true, diffFileName: 'between.tex' } as const;
      },
    };

    await manager.handleLatexdiffofOutput(1, mapping);

    assert.deepStrictEqual(roundCalls, []);
    assert.deepStrictEqual(betweenCalls, [
      { prev: prevOutput, curr: currOutput },
    ]);
    assert.deepStrictEqual(compileCalls, [
      {
        diffPath: path.join(path.dirname(prevOutput), 'between.tex'),
        buildDir: path.join('workspace', 'round0', 'build'),
      },
    ]);
  });
});
