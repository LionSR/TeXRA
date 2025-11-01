// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

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
import { WorkspaceFS } from '@utils/files';

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
  workflowContext: null,
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
    const retrieved = handler.ensureRound(2);

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

  it('ensureRound creates storage for uninitialized rounds', () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);
    const outputs = handler.ensureRound(5);

    assert.ok(Array.isArray(outputs));
    assert.strictEqual(outputs.length, 0);

    // Verify that ensureRound created storage
    assert.ok(Array.isArray(handler.outputFiles[5]));
    assert.ok(Array.isArray(handler.outputMappings[5]));
  });

  it('ensureRound returns existing outputs when called multiple times', () => {
    const handler = new MockOutputHandler(baseSetting, baseConfig);
    handler.ensureRound(2).push('existing.tex');

    const outputs = handler.ensureRound(2);

    assert.ok(Array.isArray(outputs));
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0], 'existing.tex');

    // Verify reference equality (returns the actual array, not a copy)
    assert.strictEqual(outputs, handler.outputFiles[2]);
  });
});

describe('OutputHandler.getRoundMapping', () => {
  it('caches computed mappings until invalidated', () => {
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      [path.join('workspace', 'chapter.tex')],
      new AgentLogger('TestOutputHandlerMapping'),
    );

    handler.outputFiles[0] = [path.join('workspace', 'chapter_r0.tex')];
    handler.outputMappings[0] = [
      {
        source: path.join('workspace', 'chapter_r0.tex'),
        path: path.join('workspace', 'chapter_r0.tex'),
      },
    ];

    const first = handler.getRoundMapping(0);
    const second = handler.getRoundMapping(0);

    assert.strictEqual(second, first, 'expected mapping to be cached');

    handler.outputFiles[0].push(
      path.join('workspace', 'chapter_appendix_r0.tex'),
    );
    (handler as any).invalidateRoundMapping(0);

    const third = handler.getRoundMapping(0);

    assert.notStrictEqual(
      third,
      first,
      'expected mapping to refresh after invalidation',
    );
  });
});

describe('OutputHandler.getRoundExports', () => {
  it('returns exports with optional content and caches reads', async () => {
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      [],
      new AgentLogger('TestRoundExports'),
    );

    handler.outputFiles[0] = ['chapter_r0.tex'];
    handler.outputMappings[0] = [
      { source: 'chapter.tex', path: 'chapter_r0.tex' },
    ];

    const readCalls: string[] = [];
    const originalRead = WorkspaceFS.read;
    (WorkspaceFS as any).read = async (filePath: string) => {
      readCalls.push(filePath);
      return `content:${path.basename(filePath)}`;
    };

    try {
      const metadataOnly = await handler.getRoundExports(0);
      assert.equal(metadataOnly.length, 1);
      assert.equal(metadataOnly[0].path, 'chapter_r0.tex');
      assert.equal(metadataOnly[0].source, 'chapter.tex');
      assert.ok(metadataOnly[0].exportId.length > 0);
      assert.equal(metadataOnly[0].content, undefined);

      const withContent = await handler.getRoundExports(0, {
        includeContent: true,
      });
      assert.equal(readCalls.length, 1);
      assert.equal(withContent[0].content, 'content:chapter_r0.tex');

      const second = await handler.getRoundExports(0, {
        includeContent: true,
      });
      assert.equal(readCalls.length, 1, 'expected content to be cached');
      assert.equal(second[0].content, 'content:chapter_r0.tex');
    } finally {
      (WorkspaceFS as any).read = originalRead;
    }
  });

  it('refreshes exports when round outputs change', async () => {
    const handler = new OutputHandler(
      baseSetting,
      baseConfig,
      0,
      [],
      new AgentLogger('TestRoundExportsRefresh'),
    );

    handler.outputFiles[0] = ['first_r0.tex'];
    handler.outputMappings[0] = [{ source: 'first.tex', path: 'first_r0.tex' }];

    await handler.getRoundExports(0);

    (handler as any).setRoundOutputs(
      0,
      ['second_r0.tex'],
      [{ source: 'second.tex', path: 'second_r0.tex' }],
    );

    const exports = await handler.getRoundExports(0);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].path, 'second_r0.tex');
    assert.equal(exports[0].source, 'second.tex');
    assert.ok(exports[0].exportId.includes('second'));
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
