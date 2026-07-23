// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace, TraceEmitter, type AgentTrace } from '@agent/trace';
import { OutputNode } from '@agent/implementations/flows/reflection/nodes/OutputNode';
import type { ReflectionFlowShared } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import { createOutputState, ensureRoundData } from '@agent/output/outputState';
import {
  OutputFileProcessor,
  type ProcessingContext,
} from '@agent/output/OutputFileProcessor';
import type { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { normalizeRunId } from '@common/constants/runIds';
import type {
  AgentFileLocation,
  CompileFailure,
  CompileResult,
  FileLocation,
  OutputFileInfo,
  OutputXmlSummary,
  RoundOutput,
  StreamTabId,
} from '@shared/schemas';
import { FlexibleFS } from '@utils/files';
import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
  withTestRunContext,
} from '../progressTestUtils';

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
    summary,
  };
}

const defaultWorkflowOutputPolicy = {
  shouldAutoOpenPdfOrLog: () => true,
  shouldRejectOnCompileFailure: () => true,
};

function createRoundDataStore() {
  const roundData = new Map<number, RoundOutput>();
  function ensureRoundData(round: number): RoundOutput {
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
  }
  function setRoundOutputs(round: number, outputs: OutputFileInfo[]): void {
    ensureRoundData(round).outputs = outputs;
  }
  return { roundData, ensureRoundData, setRoundOutputs };
}

function createOutputNode(
  streamId: string,
  host: ReturnType<typeof createRecordingHost>['host'],
  workflowOutputPolicy: typeof defaultWorkflowOutputPolicy = defaultWorkflowOutputPolicy,
  logger: AgentTrace = noopTrace,
  outputState = createOutputState(),
): OutputNode {
  return new OutputNode().setServices({
    streamId,
    logger,
    outputState,
    runtimeHost: host,
    workflowOutputPolicy,
  } as unknown as ReflectionServices);
}

function createRecordedRuntime(streamId: string) {
  const { events: hostEvents, host } = createRecordingHost();
  const logger = new TraceEmitter();
  const hub = new SessionEventHub();
  const typedStreamId = streamId as StreamTabId;
  const recorded = recordSessionEvents(hub, { scope: 'run' });
  const detachTrace = logger.subscribe((event) =>
    hub.emit({ scope: 'run', streamId: typedStreamId, event }),
  );
  return {
    events: recorded.events,
    host,
    hostEvents,
    logger,
    dispose: () => {
      recorded.detach();
      detachTrace();
    },
  };
}

describe('output progress events', () => {
  it('publishes output events and projects restored rounds', async () => {
    const projected = createRecordedRuntime('stream:output-node');
    const { events, host, hostEvents, logger } = projected;
    const outputLocation = createAgentLocation('/tmp/output.xml');
    const openedLocation = createLocation('/tmp/rendered.tex');
    const fileInfo: OutputFileInfo = {
      source: 'document',
      location: openedLocation,
      round: 2,
      lineage: null,
      diff: null,
    };
    const restoredFileInfo = { ...fileInfo, round: 1 };
    const persisted = createOutputState();
    ensureRoundData(persisted, 1).outputs = [restoredFileInfo];
    const outputState = createOutputState(persisted.rounds);
    const outputNode = createOutputNode(
      'stream:output-node',
      host,
      defaultWorkflowOutputPolicy,
      logger,
      outputState,
    );
    const shared = { roundOutputs: [] } as unknown as ReflectionFlowShared;
    try {
      const transition = await withTestRunContext(
        host,
        'stream:output-node',
        () =>
          outputNode.post(
            shared,
            {
              outputLocation,
              currentRound: 2,
              endTurn: false,
            },
            {
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
          ),
      );

      expect(transition).toBe('default');
      expect(runEventsOfType(events, 'addOutputFiles')).toMatchObject([
        {
          streamId: 'stream:output-node',
          filesByRound: { 2: [fileInfo] },
        },
      ]);
      expect(hostEvents).toEqual([
        {
          event: 'requestOpenFile',
          payload: { location: openedLocation, preserveFocus: true },
        },
      ]);
      // Round 0 was never populated in this fixture; the projection must
      // keep round 1's data at index 1 rather than compacting it to index 0.
      expect(shared.roundOutputs[0]).toBeUndefined();
      expect(shared.roundOutputs[1]?.outputs).toEqual([restoredFileInfo]);
    } finally {
      projected.dispose();
    }
  });

  it('stores compile failure context for the next reflection round', async () => {
    const { host } = createRecordingHost();
    const outputNode = createOutputNode('stream:compile-context', host);
    const { outputLocation, compileFailure, compileResult, summary } =
      createCompileFailureFixture();
    const shared = { roundOutputs: [] } as unknown as ReflectionFlowShared;

    await withTestRunContext(host, 'stream:compile-context', () =>
      outputNode.post(
        shared,
        {
          outputLocation,
          currentRound: 0,
          endTurn: false,
        },
        {
          summary,
          compileFailures: [compileFailure],
          compileResult,
          compiledArtifacts: [],
          emitCompileFailures: false,
        },
      ),
    );

    expect(shared.lastCompileResult).toEqual(compileResult);
    expect(shared.compileFailureContext).toContain(
      'previous workflow round was rejected',
    );
    expect(shared.compileFailureContext).toContain('! Missing $ inserted.');
  });

  it('honors disabled compile-failure repair context setting', async () => {
    const { host } = createRecordingHost();
    const outputNode = createOutputNode(
      'stream:compile-context-disabled',
      host,
      {
        ...defaultWorkflowOutputPolicy,
        shouldRejectOnCompileFailure: () => false,
      },
    );
    const { outputLocation, compileFailure, compileResult, summary } =
      createCompileFailureFixture();
    const shared = { roundOutputs: [] } as unknown as ReflectionFlowShared;

    await withTestRunContext(host, 'stream:compile-context-disabled', () =>
      outputNode.post(
        shared,
        {
          outputLocation,
          currentRound: 0,
          endTurn: false,
        },
        {
          summary,
          compileFailures: [compileFailure],
          compileResult,
          compiledArtifacts: [],
          emitCompileFailures: false,
        },
      ),
    );

    expect(shared.lastCompileResult).toEqual(compileResult);
    expect(shared.compileFailureContext).toBeUndefined();
  });

  it('clears stale compile failure context after a successful compile result', async () => {
    const { host } = createRecordingHost();
    const outputNode = createOutputNode('stream:compile-context-ok', host);
    const { outputLocation, summary } = createCompileFailureFixture();
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

    await withTestRunContext(host, 'stream:compile-context-ok', () =>
      outputNode.post(
        shared,
        {
          outputLocation,
          currentRound: 1,
          endTurn: false,
        },
        {
          summary: { ...summary, currRound: 1 },
          compileFailures: [],
          compileResult,
          compiledArtifacts: [],
          emitCompileFailures: false,
        },
      ),
    );

    expect(shared.lastCompileResult).toEqual(compileResult);
    expect(shared.compileFailureContext).toBeUndefined();
  });

  it('publishes missing-output processing events through the runtime host', async () => {
    const projected = createRecordedRuntime('stream:processor');
    const { events, host, logger } = projected;
    const { roundData, ensureRoundData, setRoundOutputs } =
      createRoundDataStore();
    const xmlManager = {
      splitScratchpadMultipleOutputXml: async () => {
        throw new Error('invalid xml');
      },
    } as unknown as XmlOutputManager;
    const context: ProcessingContext = {
      baseFiles: [],
      streamId: 'stream:processor',
      runtimeHost: host,
      logger,
      xmlManager,
      setRoundOutputs,
      ensureRoundData,
    };

    try {
      await new OutputFileProcessor(context).processMultipleOutputs(
        createLocation('/tmp/broken-output.xml'),
        3,
        createLocation('/tmp/raw-output.xml'),
      );

      expect(runEventsOfType(events, 'updateMissingOutputs')).toMatchObject([
        {
          streamId: 'stream:processor',
          filesByRound: { 3: [] },
        },
      ]);
      expect(roundData.get(3)?.outputs).toEqual([]);
    } finally {
      projected.dispose();
    }
  });

  it('emits missing-output events when extraction yields no files (no exception)', async () => {
    const projected = createRecordedRuntime('stream:processor');
    const { events, host, logger } = projected;
    const { roundData, ensureRoundData, setRoundOutputs } =
      createRoundDataStore();
    const xmlManager = {
      splitScratchpadMultipleOutputXml: async () => [],
    } as unknown as XmlOutputManager;
    const context: ProcessingContext = {
      baseFiles: [],
      streamId: 'stream:processor',
      runtimeHost: host,
      logger,
      xmlManager,
      setRoundOutputs,
      ensureRoundData,
    };

    try {
      await new OutputFileProcessor(context).processMultipleOutputs(
        createLocation('/tmp/empty-output.xml'),
        4,
        createLocation('/tmp/raw-output.xml'),
      );

      expect(runEventsOfType(events, 'updateMissingOutputs')).toMatchObject([
        {
          streamId: 'stream:processor',
          filesByRound: { 4: [] },
        },
      ]);
      expect(roundData.get(4)?.outputs).toEqual([]);
    } finally {
      projected.dispose();
    }
  });

  it('warns when a non-empty response yields zero extracted files', async () => {
    // Regression: a run where the model returned content but nothing could be
    // extracted (e.g. it did not wrap files in <documents>) used to "complete"
    // silently with only the raw output. It must now surface a warning. Stub
    // the read so the model output is treated as non-empty.
    const readSpy = vi
      .spyOn(FlexibleFS, 'read')
      .mockResolvedValue('% chunk.tex\n\\section{Untagged content}\n');
    const projected = createRecordedRuntime('stream:processor');
    const { events, host, logger } = projected;
    const warnings: string[] = [];
    const detachWarnings = logger.subscribe((event) => {
      if (event.type === 'log' && event.level === 'warn') {
        warnings.push(event.message);
      }
    });
    try {
      const { ensureRoundData, setRoundOutputs } = createRoundDataStore();
      const xmlManager = {
        splitScratchpadMultipleOutputXml: async () => [],
      } as unknown as XmlOutputManager;
      const context: ProcessingContext = {
        baseFiles: [],
        streamId: 'stream:processor',
        runtimeHost: host,
        logger,
        xmlManager,
        setRoundOutputs,
        ensureRoundData,
      };

      await new OutputFileProcessor(context).processMultipleOutputs(
        createLocation('/tmp/output.xml'),
        5,
        createLocation('/tmp/output.xml'),
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('no files could be extracted');
      // The missing-output signal is still emitted alongside the warning.
      expect(runEventsOfType(events, 'updateMissingOutputs')).toMatchObject([
        {
          streamId: 'stream:processor',
          filesByRound: { 5: [] },
        },
      ]);
    } finally {
      detachWarnings();
      projected.dispose();
      readSpy.mockRestore();
    }
  });
});
