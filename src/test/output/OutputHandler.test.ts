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

const baseSetting: AgentSetting = {
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

const baseConfig: AgentConfig = {
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

describe('OutputHandler round helpers', () => {
  it('ensures round storage and returns the same reference', () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);
    const roundOutputs = handler.ensureRound(2);

    assert.ok(Array.isArray(roundOutputs));
    assert.strictEqual(roundOutputs.length, 0);

    roundOutputs.push('out.tex');
    const retrieved = handler.getRoundOutputs(2);

    assert.strictEqual(retrieved, roundOutputs);
    assert.deepEqual(retrieved, ['out.tex']);
  });

  it('reflects whether rounds contain outputs', () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);

    assert.strictEqual(handler.hasRoundOutputs(1), false);

    handler.ensureRound(1).push('out-1.tex');

    assert.strictEqual(handler.hasRoundOutputs(1), true);
    assert.strictEqual(handler.hasRoundOutputs(3), false);
  });

  it('getRoundOutputs returns empty array for uninitialized rounds', () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);
    const outputs = handler.getRoundOutputs(5);

    assert.ok(Array.isArray(outputs));
    assert.strictEqual(outputs.length, 0);

    // Verify that getRoundOutputs did NOT create storage (read-only behavior)
    assert.strictEqual(handler.outputFiles[5], undefined);
    assert.strictEqual(handler.outputMappings[5], undefined);
  });

  it('getRoundOutputs returns existing outputs without modifying state', () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);
    handler.ensureRound(2).push('existing.tex');

    const outputs = handler.getRoundOutputs(2);

    assert.ok(Array.isArray(outputs));
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0], 'existing.tex');

    // Verify reference equality (returns the actual array, not a copy)
    assert.strictEqual(outputs, handler.outputFiles[2]);
  });
});

describe('OutputHandler.finalizeRound', () => {
  it('emits addOutputFiles and validates when endTurn', async () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);
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
    const handler = new MockOutputHandler(baseSetting, baseConfig);
    const events: any[] = [];
    const dispose = bus.on('addOutputFiles', (data) => events.push(data));

    await handler.finalizeRound('out.xml', 0, { endTurn: false });

    assert.ok(handler.gatherCalled);
    assert.strictEqual(handler.validateCalled, false);
    assert.equal(events.length, 1);
    dispose();
  });
});
