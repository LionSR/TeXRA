// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace, TraceEmitter, type AgentTrace } from '@agent/trace';
import { OutputNode } from '@agent/implementations/flows/reflection/nodes/OutputNode';
import type { ReflectionFlowShared } from '@agent/implementations/flows/reflection/ReflectionFlowState';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import {
  createOutputState,
  ensureRoundData,
} from '@agent/implementations/flows/reflection/output/outputState';
import { OutputFileProcessor } from '@agent/implementations/flows/reflection/output/OutputFileProcessor';
import type { OutputDependencies } from '@agent/implementations/flows/reflection/output/outputState';
import type { XmlOutputManager } from '@agent/implementations/flows/reflection/output/XmlOutputManager';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type {
  AgentFileLocation,
  CompileFailure,
  CompileResult,
  FileLocation,
  OutputFileInfo,
  StorageKey,
  StreamTabId,
} from '@shared/schemas';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import {
  createExternalLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
  testRunScope,
  withTestRunContext,
} from '../progressTestUtils';

function createLocation(path: string): FileLocation {
  return createExternalLocation(path);
}

function createAgentLocation(path: string): AgentFileLocation {
  return createWorkspaceLocation(path, path);
}

const defaultWorkflowOutputPolicy = {
  shouldAutoOpenPdfOrLog: () => true,
  shouldRejectOnCompileFailure: () => true,
};

/**
 * Minimal OutputDependencies for OutputFileProcessor tests: the processor
 * reads only `baseFiles`, `logger`, and `runScope.streamId`.
 */
function processorDeps(logger: AgentTrace): OutputDependencies {
  return {
    baseFiles: [],
    logger,
    runScope: { streamId: 'stream:processor' },
  } as unknown as OutputDependencies;
}

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
    storageKey: 'run:compile-context' as StorageKey,
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

function createOutputNode(
  streamId: string,
  host: ReturnType<typeof createRecordingHost>['host'],
  workflowOutputPolicy: typeof defaultWorkflowOutputPolicy = defaultWorkflowOutputPolicy,
  logger: AgentTrace = noopTrace,
  outputState = createOutputState(),
): OutputNode {
  return new OutputNode().setServices({
    streamId,
    runScope: testRunScope(streamId, { interactions: host }),
    logger,
    outputState,
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

type OutputPostArgs = Parameters<OutputNode['post']>;

function runOutputPost(
  outputNode: OutputNode,
  shared: ReflectionFlowShared,
  prepRes: OutputPostArgs[1],
  execRes: OutputPostArgs[2],
): ReturnType<OutputNode['post']> {
  return withTestRunContext(outputNode.services.runScope, () =>
    outputNode.post(shared, prepRes, execRes),
  );
}

function compileContextCase(
  streamId: string,
  workflowOutputPolicy = defaultWorkflowOutputPolicy,
): {
  outputNode: OutputNode;
  fixture: ReturnType<typeof createCompileFailureFixture>;
  shared: ReflectionFlowShared;
} {
  const { host } = createRecordingHost();
  return {
    outputNode: createOutputNode(streamId, host, workflowOutputPolicy),
    fixture: createCompileFailureFixture(),
    shared: { roundOutputs: [] } as unknown as ReflectionFlowShared,
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
      const transition = await runOutputPost(
        outputNode,
        shared,
        {
          outputLocation,
          currentRound: 2,
          endTurn: false,
        },
        {
          summary: {
            storageKey: 'run:output-node' as StorageKey,
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

  it.each([
    {
      name: 'stores compile failure context for the next reflection round',
      streamId: 'stream:compile-context',
      rejectOnCompileFailure: true,
    },
    {
      name: 'honors disabled compile-failure repair context setting',
      streamId: 'stream:compile-context-disabled',
      rejectOnCompileFailure: false,
    },
  ])('$name', async ({ streamId, rejectOnCompileFailure }) => {
    const { outputNode, fixture, shared } = compileContextCase(streamId, {
      ...defaultWorkflowOutputPolicy,
      shouldRejectOnCompileFailure: () => rejectOnCompileFailure,
    });

    await runOutputPost(
      outputNode,
      shared,
      {
        outputLocation: fixture.outputLocation,
        currentRound: 0,
        endTurn: false,
      },
      {
        summary: fixture.summary,
        compileFailures: [fixture.compileFailure],
        compileResult: fixture.compileResult,
        compiledArtifacts: [],
        emitCompileFailures: false,
      },
    );

    if (rejectOnCompileFailure) {
      expect(shared.compileFailureContext).toContain(
        'previous workflow round was rejected',
      );
      expect(shared.compileFailureContext).toContain('! Missing $ inserted.');
    } else {
      expect(shared.compileFailureContext).toBeUndefined();
    }
  });

  it('clears stale compile failure context after a successful compile result', async () => {
    const { outputNode, fixture } = compileContextCase(
      'stream:compile-context-ok',
    );
    const compileResult: CompileResult = { status: 'ok', round: 1 };
    const shared = {
      roundOutputs: [],
      compileFailureContext: 'old context',
    } as unknown as ReflectionFlowShared;

    await runOutputPost(
      outputNode,
      shared,
      {
        outputLocation: fixture.outputLocation,
        currentRound: 1,
        endTurn: false,
      },
      {
        summary: { ...fixture.summary, currRound: 1 },
        compileFailures: [],
        compileResult,
        compiledArtifacts: [],
        emitCompileFailures: false,
      },
    );

    expect(shared.compileFailureContext).toBeUndefined();
  });

  it.each([
    {
      name: 'publishes missing-output processing events on the run trace',
      split: async () => {
        throw new Error('invalid xml');
      },
      outputPath: '/tmp/broken-output.xml',
      round: 3,
    },
    {
      name: 'emits missing-output events when extraction yields no files (no exception)',
      split: async () => [],
      outputPath: '/tmp/empty-output.xml',
      round: 4,
    },
  ])('$name', async ({ split, outputPath, round }) => {
    const projected = createRecordedRuntime('stream:processor');
    const { events, logger } = projected;
    const state = createOutputState();
    const xmlManager = {
      splitScratchpadMultipleOutputXml: split,
    } as unknown as XmlOutputManager;

    try {
      await new OutputFileProcessor(
        state,
        processorDeps(logger),
        xmlManager,
      ).processMultipleOutputs(createLocation(outputPath), round);

      expect(runEventsOfType(events, 'updateMissingOutputs')).toMatchObject([
        {
          streamId: 'stream:processor',
          filesByRound: { [round]: [] },
        },
      ]);
      expect(state.rounds.get(round)?.outputs).toEqual([]);
    } finally {
      projected.dispose();
    }
  });

  it('warns when a non-empty response yields zero extracted files', async () => {
    // A run where the model returned content but nothing could be extracted
    // (e.g. it did not wrap files in <documents>) must surface a warning
    // rather than completing silently with only the raw output. Stub the read
    // so the model output is treated as non-empty.
    const readSpy = vi
      .spyOn(AbsoluteFS, 'read')
      .mockResolvedValue('% chunk.tex\n\\section{Untagged content}\n');
    const projected = createRecordedRuntime('stream:processor');
    const { events, logger } = projected;
    const warnings: string[] = [];
    const detachWarnings = logger.subscribe((event) => {
      if (event.type === 'log' && event.level === 'warn') {
        warnings.push(event.message);
      }
    });
    try {
      const xmlManager = {
        splitScratchpadMultipleOutputXml: async () => [],
      } as unknown as XmlOutputManager;

      await new OutputFileProcessor(
        createOutputState(),
        processorDeps(logger),
        xmlManager,
      ).processMultipleOutputs(createLocation('/tmp/output.xml'), 5);

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
