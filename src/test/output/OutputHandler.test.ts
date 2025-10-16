// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import type { AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentType,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { OutputHandler } from '@agent/output';

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';

class MockOutputHandler extends OutputHandler {
  public gatherCalled = false;
  public validateCalled = false;

  constructor(setting: AgentSetting, config: AgentConfig) {
    super(setting, config, 0, [], new AgentLogger('TestOutputHandler'));
  }

  public override async gatherOutputFileInfo(round: number) {
    this.gatherCalled = true;
    return [
      {
        path: `out${round}.tex`,
        base: null,
        prev: null,
        original: null,
      } as any,
    ];
  }

  public override async validateExpectedOutputs(
    outputFile: string,
    currRound: number,
    groupId?: string,
  ): Promise<void> {
    this.validateCalled = true;
  }
}

describe('OutputHandler.finalizeRound', () => {
  const setting: AgentSetting = {
    agentType: AgentType.CoT,
    agentCategory: AgentCategory.Workflow,
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
    isMultipleOutput: false,
    filePatternsContain: [],
    tools: [],
  };

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

  it('emits addOutputFiles and validates when endTurn', async () => {
    const handler = new MockOutputHandler(setting, config);
    const events: any[] = [];
    const dispose = bus.on('addOutputFiles', (data) => events.push(data));

    await handler.finalizeRound('out.xml', 0, { endTurn: true });

    assert.ok(handler.gatherCalled);
    assert.ok(handler.validateCalled);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].filesByRound[0], [
      { path: 'out0.tex', base: null, prev: null, original: null },
    ]);
    dispose();
  });

  it('skips validation when not endTurn', async () => {
    const handler = new MockOutputHandler(setting, config);
    const events: any[] = [];
    const dispose = bus.on('addOutputFiles', (data) => events.push(data));

    await handler.finalizeRound('out.xml', 0, { endTurn: false });

    assert.ok(handler.gatherCalled);
    assert.strictEqual(handler.validateCalled, false);
    assert.equal(events.length, 1);
    dispose();
  });
});

describe('OutputHandler.getRoundFileMapping', () => {
  const setting: AgentSetting = {
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
  };

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

  it('caches mapping per round and exposes origin data', () => {
    const handler = new OutputHandler(
      setting,
      config,
      0,
      ['workspace/base/ch1.tex'],
      new AgentLogger('TestOutputHandler'),
    );

    handler.outputFiles[0] = ['workspace/output/ch1.tex'];
    handler.outputMappings[0] = [
      { source: 'workspace/xml/ch1.tex', path: 'workspace/output/ch1.tex' },
    ];

    const first = handler.getRoundFileMapping(0);
    const second = handler.getRoundFileMapping(0);

    assert.strictEqual(first, second);
    assert.strictEqual(
      first.baseToOutput.get('workspace/base/ch1.tex'),
      'workspace/output/ch1.tex',
    );
    assert.strictEqual(
      first.outputToOrigin.get('workspace/output/ch1.tex'),
      'workspace/xml/ch1.tex',
    );
  });

  it('includes previous round relationships when available', () => {
    const handler = new OutputHandler(
      setting,
      config,
      0,
      ['workspace/base/ch1.tex'],
      new AgentLogger('TestOutputHandler'),
    );

    handler.outputFiles[0] = ['workspace/round0/ch1.tex'];
    handler.outputMappings[0] = [
      {
        source: 'workspace/xml/round0/ch1.tex',
        path: 'workspace/round0/ch1.tex',
      },
    ];
    handler.outputFiles[1] = ['workspace/round1/ch1.tex'];
    handler.outputMappings[1] = [
      {
        source: 'workspace/xml/round1/ch1.tex',
        path: 'workspace/round1/ch1.tex',
      },
    ];

    const mapping = handler.getRoundFileMapping(1);

    assert.strictEqual(
      mapping.prevToCurrent.get('workspace/round0/ch1.tex'),
      'workspace/round1/ch1.tex',
    );
    assert.strictEqual(
      mapping.outputToOrigin.get('workspace/round1/ch1.tex'),
      'workspace/xml/round1/ch1.tex',
    );
  });
});
