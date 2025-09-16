// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import type { AgentConfig } from '@agent/core/AgentConfig';

// Local imports
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { OutputHandler } from '@agent/output/OutputHandler';
import { MultipleOutputStrategy } from '@agent/output/strategies/MultipleOutputStrategy';
import { AgentLogger } from '@logger/AgentLogger';

const baseSetting: AgentSetting = {
  agentType: AgentType.CoT,
  documentTag: 'document',
  temperature: 0,
  isRewrite: true,
  rounds: 1,
  prefills: [],
  outputExt: 'tex',
  endTag: '</latex_document>',
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
  tools: [],
};

const baseConfig: AgentConfig = {
  model: 'test',
  agent: 'a',
  instruction: '',
  inputFile: 'input.tex',
  inputFiles: null,
  referenceFile: null,
  referenceFiles: null,
  auxiliaryFile: null,
  auxiliaryFiles: null,
  mediaFile: null,
  mediaFiles: null,
  outputFiles: ['paper.tex'],
  editedFile: null,
  toolConfig: {
    reflect: false,
    usePrefillFromInput: false,
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    attachTeXCount: false,
    attachDiagnostics: false,
    printInputPrompt: false,
    autoCompileInputPdf: false,
  },
};

function createHandler(): OutputHandler {
  const logger = new AgentLogger('MultipleOutputStrategyTest');
  const handler = new OutputHandler(
    { ...baseSetting },
    { ...baseConfig },
    0,
    [],
    logger,
  );
  return handler;
}

describe('MultipleOutputStrategy', () => {
  it('records processed files from the XML manager', async () => {
    const handler = createHandler();
    const strategy = new MultipleOutputStrategy();
    const indentCalls: string[][] = [];

    handler.xmlManager.processMultipleXmlOutputs = async () => [
      { source: 'round0.xml', path: 'output_a.tex' },
      { source: 'round0.xml', path: 'output_b.tex' },
    ];
    handler.indentLatexFiles = async (files: string[]) => {
      indentCalls.push(files);
    };

    await strategy.process('round0.xml', 0, handler);

    assert.deepEqual(handler.outputFiles[0], ['output_a.tex', 'output_b.tex']);
    assert.deepEqual(handler.outputMappings[0], [
      { source: 'round0.xml', path: 'output_a.tex' },
      { source: 'round0.xml', path: 'output_b.tex' },
    ]);
    assert.deepEqual(indentCalls, [['output_a.tex', 'output_b.tex']]);
  });

  it('handles cases where no files are produced', async () => {
    const handler = createHandler();
    const strategy = new MultipleOutputStrategy();
    const indentCalls: string[][] = [];

    handler.xmlManager.processMultipleXmlOutputs = async () => [];
    handler.indentLatexFiles = async (files: string[]) => {
      indentCalls.push(files);
    };

    await strategy.process('round1.xml', 1, handler);

    assert.deepEqual(handler.outputFiles[1], []);
    assert.deepEqual(handler.outputMappings[1], []);
    assert.deepEqual(indentCalls, []);
  });

  it('clears state when processing throws an error', async () => {
    const handler = createHandler();
    const strategy = new MultipleOutputStrategy();
    const indentCalls: string[][] = [];

    handler.xmlManager.processMultipleXmlOutputs = async () => {
      throw new Error('failure');
    };
    handler.indentLatexFiles = async (files: string[]) => {
      indentCalls.push(files);
    };

    await strategy.process('round2.xml', 2, handler);

    assert.deepEqual(handler.outputFiles[2], []);
    assert.deepEqual(handler.outputMappings[2], []);
    assert.deepEqual(indentCalls, []);
  });
});
