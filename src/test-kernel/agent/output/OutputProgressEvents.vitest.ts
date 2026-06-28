// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { OutputNode } from '@agent/implementations/flows/reflection/nodes/OutputNode';
import type { ReflectionFlowShared } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import { createOutputState } from '@agent/output/outputState';
import {
  OutputFileProcessor,
  type ProcessingContext,
} from '@agent/output/OutputFileProcessor';
import type { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { flexibleFS } from '@utils/files';
import { normalizeRunId } from '@common/constants/runIds';
import type {
  AgentFileLocation,
  CompileFailure,
  CompileResult,
  FileLocation,
  OutputFileInfo,
  OutputXmlSummary,
  RoundOutput,
} from '@shared/schemas';
import { createRecordingHost } from '../progressTestUtils';

function createLocation(path: string): FileLocation {
  return { kind: 'external', absolutePath: path };
}

function createAgentLocation(path: string): AgentFileLocation {
  return { kind: 'workspace', absolutePath: path, relativePath: path };
}

const emptyXmlSummary: OutputXmlSummary = {
  tagContents: {},
  documents: [],
  singleOutputFile: null,
  sourceLocation: null,
};

function createCompileFailureFixture() {
  const outputLocation = createAgentLocation('/tmp/output.xml');
  const texLocation = createLocation('/tmp/rendered.tex');
  const logLocation = createLocation('/tmp/compile.log');
  const compileFailure: CompileFailure = {
    round: 0,
    displayName: 'rendered.tex',
    output: texLocation,
    log: logLocation,
    logRelativePath: 'compile/r0_rendered.tex.log',
  };
  const compileResult: CompileResult = {
    status: 'failed',
    round: 0,
    failures: [compileFailure],
    logExcerpt: '! Missing $ inserted.',
  };
  const roundOutput: RoundOutput = {
    round: 0,
    rawOutput: outputLocation,
    outputs: [],
    compileFailures: [compileFailure],
    xmlSummary: emptyXmlSummary,
  };
  const summary = {
    storageKey: normalizeRunId('run:compile-context'),
    currRound: 0,
    fileInfos: [],
    filesToOpen: [],
    outputFile: outputLocation,
    endTurn: false,
  };

  return {
    outputLocation,
    compileFailure,
    compileResult,
    roundOutput,
    summary,
  };
}

const defaultWorkflowOutputPolicy = {
  shouldAutoOpenPdfOrLog: () => true,
  shouldRejectOnCompileFailure: () => true,
};

describe('output progress events', () => {
  it('publishes reflection output-node events through the runtime host', async () => {
    const { events, host } = createRecordingHost();
    const outputNode = new OutputNode().setServices({
      streamId: 'stream:output-node',
      logger: { warn: () => {} },
      outputState: createOutputState(),
      runtimeHost: host,
      workflowOutputPolicy: defaultWorkflowOutputPolicy,
    } as unknown as ReflectionServices);
    const outputLocation = createAgentLocation('/tmp/output.xml');
    const openedLocation = createLocation('/tmp/rendered.tex');
    const fileInfo: OutputFileInfo = {
      source: 'document',
      location: openedLocation,
      round: 2,
      lineage: null,
      diff: null,
    };
    const roundOutput: RoundOutput = {
      round: 2,
      rawOutput: outputLocation,
      outputs: [fileInfo],
      compileFailures: [],
      xmlSummary: emptyXmlSummary,
    };

    const transition = await outputNode.post(
      { roundOutputs: [] } as never,
      {
        outputLocation,
        currentRound: 2,
        endTurn: false,
      },
      {
        roundOutput,
        summary: {
          storageKey: normalizeRunId('run:output-node'),
          currRound: 2,
          fileInfos: [fileInfo],
          filesToOpen: [openedLocation],
          outputFile: outputLocation,
          endTurn: false,
        },
        compileFailures: [],
        compiledArtifacts: [],
        emitCompileFailures: false,
      },
    );

    expect(transition).toBe('default');
    expect(events).toEqual([
      {
        event: 'addOutputFiles',
        payload: {
          streamId: 'stream:output-node',
          filesByRound: { 2: [fileInfo] },
        },
      },
      {
        event: 'requestOpenFile',
        payload: { location: openedLocation, preserveFocus: true },
      },
    ]);
  });

  it('stores compile failure context for the next reflection round', async () => {
    const { host } = createRecordingHost();
    const outputNode = new OutputNode().setServices({
      streamId: 'stream:compile-context',
      logger: { warn: () => {} },
      outputState: createOutputState(),
      runtimeHost: host,
      workflowOutputPolicy: defaultWorkflowOutputPolicy,
    } as unknown as ReflectionServices);
    const {
      outputLocation,
      compileFailure,
      compileResult,
      roundOutput,
      summary,
    } = createCompileFailureFixture();
    const shared = { roundOutputs: [] } as unknown as ReflectionFlowShared;

    await outputNode.post(
      shared,
      {
        outputLocation,
        currentRound: 0,
        endTurn: false,
      },
      {
        roundOutput,
        summary,
        compileFailures: [compileFailure],
        compileResult,
        compiledArtifacts: [],
        emitCompileFailures: false,
      },
    );

    expect(shared.lastCompileResult).toEqual(compileResult);
    expect(shared.compileFailureContext).toContain(
      'previous workflow round was rejected',
    );
    expect(shared.compileFailureContext).toContain('! Missing $ inserted.');
  });

  it('honors disabled compile-failure repair context setting', async () => {
    const { host } = createRecordingHost();
    const outputNode = new OutputNode().setServices({
      streamId: 'stream:compile-context-disabled',
      logger: { warn: () => {} },
      outputState: createOutputState(),
      runtimeHost: host,
      workflowOutputPolicy: {
        ...defaultWorkflowOutputPolicy,
        shouldRejectOnCompileFailure: () => false,
      },
    } as unknown as ReflectionServices);
    const {
      outputLocation,
      compileFailure,
      compileResult,
      roundOutput,
      summary,
    } = createCompileFailureFixture();
    const shared = { roundOutputs: [] } as unknown as ReflectionFlowShared;

    await outputNode.post(
      shared,
      {
        outputLocation,
        currentRound: 0,
        endTurn: false,
      },
      {
        roundOutput,
        summary,
        compileFailures: [compileFailure],
        compileResult,
        compiledArtifacts: [],
        emitCompileFailures: false,
      },
    );

    expect(shared.lastCompileResult).toEqual(compileResult);
    expect(shared.compileFailureContext).toBeUndefined();
  });

  it('clears stale compile failure context after a successful compile result', async () => {
    const { host } = createRecordingHost();
    const outputNode = new OutputNode().setServices({
      streamId: 'stream:compile-context-ok',
      logger: { warn: () => {} },
      outputState: createOutputState(),
      runtimeHost: host,
      workflowOutputPolicy: defaultWorkflowOutputPolicy,
    } as unknown as ReflectionServices);
    const { outputLocation, roundOutput, summary } =
      createCompileFailureFixture();
    const compileResult: CompileResult = { status: 'ok', round: 1 };
    const shared = {
      roundOutputs: [],
      compileFailureContext: 'old context',
      lastCompileResult: {
        status: 'failed',
        round: 0,
        failures: [],
        logExcerpt: 'old log',
      },
    } as unknown as ReflectionFlowShared;

    await outputNode.post(
      shared,
      {
        outputLocation,
        currentRound: 1,
        endTurn: false,
      },
      {
        roundOutput: { ...roundOutput, round: 1, compileFailures: [] },
        summary: { ...summary, currRound: 1 },
        compileFailures: [],
        compileResult,
        compiledArtifacts: [],
        emitCompileFailures: false,
      },
    );

    expect(shared.lastCompileResult).toEqual(compileResult);
    expect(shared.compileFailureContext).toBeUndefined();
  });

  it('publishes missing-output processing events through the runtime host', async () => {
    const { events, host } = createRecordingHost();
    const roundData = new Map<number, RoundOutput>();
    const logger = {
      debug: () => {},
      domain: () => {},
    } as unknown as AgentTrace;
    const xmlManager = {
      splitScratchpadMultipleOutputXml: async () => {
        throw new Error('invalid xml');
      },
    } as unknown as XmlOutputManager;
    const ensureRound = (round: number): RoundOutput => {
      let data = roundData.get(round);
      if (!data) {
        data = {
          round,
          outputs: [],
          compileFailures: [],
          rawOutput: null,
          xmlSummary: emptyXmlSummary,
        };
        roundData.set(round, data);
      }
      return data;
    };
    const setRoundOutputs = (round: number, outputs: OutputFileInfo[]) => {
      const data = ensureRound(round);
      data.outputs = outputs;
    };
    const context: ProcessingContext = {
      agentSetting: {
        agentCategory: AgentCategory.Workflow,
        documentTag: 'documents',
      } as ProcessingContext['agentSetting'],
      baseFiles: [],
      streamId: 'stream:processor',
      runtimeHost: host,
      logger,
      xmlManager,
      setRoundOutputs,
      ensureRoundData: ensureRound,
    };

    await new OutputFileProcessor(context).processMultipleOutputs(
      createLocation('/tmp/broken-output.xml'),
      3,
      createLocation('/tmp/raw-output.xml'),
    );

    expect(events).toEqual([
      {
        event: 'updateMissingOutputs',
        payload: {
          streamId: 'stream:processor',
          filesByRound: { 3: [] },
        },
      },
    ]);
    expect(roundData.get(3)?.outputs).toEqual([]);
  });

  it('emits missing-output events when extraction yields no files (no exception)', async () => {
    const { events, host } = createRecordingHost();
    const roundData = new Map<number, RoundOutput>();
    const logger = {
      debug: () => {},
      domain: () => {},
    } as unknown as AgentTrace;
    const xmlManager = {
      splitScratchpadMultipleOutputXml: async () => [],
    } as unknown as XmlOutputManager;
    const ensureRound = (round: number): RoundOutput => {
      let data = roundData.get(round);
      if (!data) {
        data = {
          round,
          outputs: [],
          compileFailures: [],
          rawOutput: null,
          xmlSummary: emptyXmlSummary,
        };
        roundData.set(round, data);
      }
      return data;
    };
    const setRoundOutputs = (round: number, outputs: OutputFileInfo[]) => {
      const data = ensureRound(round);
      data.outputs = outputs;
    };
    const context: ProcessingContext = {
      agentSetting: {
        agentCategory: AgentCategory.Workflow,
        documentTag: 'documents',
      } as ProcessingContext['agentSetting'],
      baseFiles: [],
      streamId: 'stream:processor',
      runtimeHost: host,
      logger,
      xmlManager,
      setRoundOutputs,
      ensureRoundData: ensureRound,
    };

    await new OutputFileProcessor(context).processMultipleOutputs(
      createLocation('/tmp/empty-output.xml'),
      4,
      createLocation('/tmp/raw-output.xml'),
    );

    expect(events).toEqual([
      {
        event: 'updateMissingOutputs',
        payload: {
          streamId: 'stream:processor',
          filesByRound: { 4: [] },
        },
      },
    ]);
    expect(roundData.get(4)?.outputs).toEqual([]);
  });

  it('warns when a non-empty response yields zero extracted files', async () => {
    // Regression: a run where the model returned content but nothing could be
    // extracted (e.g. it did not wrap files in <documents>) used to "complete"
    // silently with only the raw output. It must now surface a warning. Stub
    // the read so the model output is treated as non-empty.
    const readSpy = vi
      .spyOn(flexibleFS, 'read')
      .mockResolvedValue('% chunk.tex\n\\section{Untagged content}\n');
    try {
      const { events, host } = createRecordingHost();
      const warnings: string[] = [];
      const roundData = new Map<number, RoundOutput>();
      const logger = {
        debug: () => {},
        domain: () => {},
        warn: (message: string) => warnings.push(message),
      } as unknown as AgentTrace;
      const xmlManager = {
        splitScratchpadMultipleOutputXml: async () => [],
      } as unknown as XmlOutputManager;
      const ensureRound = (round: number): RoundOutput => {
        let data = roundData.get(round);
        if (!data) {
          data = {
            round,
            outputs: [],
            compileFailures: [],
            rawOutput: null,
            xmlSummary: emptyXmlSummary,
          };
          roundData.set(round, data);
        }
        return data;
      };
      const context: ProcessingContext = {
        agentSetting: {
          agentCategory: AgentCategory.Workflow,
          documentTag: 'documents',
        } as ProcessingContext['agentSetting'],
        baseFiles: [],
        streamId: 'stream:processor',
        runtimeHost: host,
        logger,
        xmlManager,
        setRoundOutputs: (round, outputs) => {
          ensureRound(round).outputs = outputs;
        },
        ensureRoundData: ensureRound,
      };

      await new OutputFileProcessor(context).processMultipleOutputs(
        createLocation('/tmp/output.xml'),
        5,
        createLocation('/tmp/output.xml'),
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('no files could be extracted');
      // The missing-output signal is still emitted alongside the warning.
      expect(events).toEqual([
        {
          event: 'updateMissingOutputs',
          payload: { streamId: 'stream:processor', filesByRound: { 5: [] } },
        },
      ]);
    } finally {
      readSpy.mockRestore();
    }
  });
});
