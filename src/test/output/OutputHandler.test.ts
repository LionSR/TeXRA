// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
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
    useMultipleOutputs: false,
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
      reflect: false,
      autoExtractFigure: false,
      autoExtractTikzFigure: false,
      attachTeXCount: false,
      attachDiagnostics: false,
      printInputPrompt: false,
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
