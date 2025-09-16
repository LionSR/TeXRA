// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import type { AgentConfig } from '@agent/core/AgentConfig';

// Local imports
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { OutputHandler } from '@agent/output/OutputHandler';
import { SingleOutputStrategy } from '@agent/output/strategies/SingleOutputStrategy';
import { bus } from '@eventBus/ProgressEventBus';
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
  outputFiles: null,
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

function createHandler(settingOverride?: Partial<AgentSetting>): OutputHandler {
  const setting = { ...baseSetting, ...settingOverride };
  const logger = new AgentLogger('SingleOutputStrategyTest');
  const handler = new OutputHandler(setting, { ...baseConfig }, 0, [], logger);
  return handler;
}

describe('SingleOutputStrategy', () => {
  it('processes a single output file and records mappings', async () => {
    const handler = createHandler();
    const strategy = new SingleOutputStrategy();
    const indentCalls: string[] = [];

    handler.xmlManager.processSingleXmlOutput = async () => ({
      source: 'round0.xml',
      path: 'round0.tex',
    });
    handler.indentLatexFile = async (filePath: string) => {
      indentCalls.push(filePath);
    };

    await strategy.process('round0.xml', 0, handler);

    assert.deepEqual(handler.outputFiles[0], ['round0.tex']);
    assert.deepEqual(handler.outputMappings[0], [
      { source: 'round0.xml', path: 'round0.tex' },
    ]);
    assert.deepEqual(indentCalls, ['round0.tex']);
  });

  it('skips XML processing for direct agents', async () => {
    const handler = createHandler({ agentType: AgentType.Direct });
    const strategy = new SingleOutputStrategy();
    let xmlCalled = false;
    const indentCalls: string[] = [];

    handler.xmlManager.processSingleXmlOutput = async () => {
      xmlCalled = true;
      return { source: 'unused', path: 'unused.tex' };
    };
    handler.indentLatexFile = async (filePath: string) => {
      indentCalls.push(filePath);
    };

    await strategy.process('direct.tex', 1, handler);

    assert.strictEqual(xmlCalled, false);
    assert.deepEqual(handler.outputFiles[1], ['direct.tex']);
    assert.deepEqual(handler.outputMappings[1], [
      { source: 'direct.tex', path: 'direct.tex' },
    ]);
    assert.deepEqual(indentCalls, ['direct.tex']);
  });

  it('emits missing outputs when processing fails', async () => {
    const handler = createHandler();
    const strategy = new SingleOutputStrategy();
    const indentCalls: string[] = [];
    handler.xmlManager.processSingleXmlOutput = async () => {
      throw new Error('fail');
    };
    handler.indentLatexFile = async (filePath: string) => {
      indentCalls.push(filePath);
    };

    const events: any[] = [];
    const dispose = bus.on('updateMissingOutputs', (payload) => {
      events.push(payload);
    });

    await strategy.process('error.xml', 2, handler);

    assert.deepEqual(handler.outputFiles[2], []);
    assert.deepEqual(handler.outputMappings[2], []);
    assert.deepEqual(indentCalls, []);
    assert.strictEqual(events.length, 1);
    assert.deepEqual(events[0].filesByRound[2], []);

    dispose();
  });
});
