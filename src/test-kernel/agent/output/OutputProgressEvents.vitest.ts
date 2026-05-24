// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { OutputNode } from '@agent/implementations/flows/reflection/nodes/OutputNode';
import type { ReflectionServices } from '@agent/implementations/flows/reflection/ReflectionServices';
import { createOutputState, type RoundData } from '@agent/output/outputState';
import {
  OutputFileProcessor,
  type ProcessingContext,
} from '@agent/output/OutputFileProcessor';
import type { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { normalizeRunId } from '@common/constants/runIds';
import type {
  AgentFileLocation,
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

describe('output progress events', () => {
  it('publishes reflection output-node events through the runtime host', async () => {
    const { events, host } = createRecordingHost();
    const outputNode = new OutputNode().setServices({
      streamId: 'stream:output-node',
      logger: { warn: () => {} },
      outputState: createOutputState(),
      runtimeHost: host,
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

  it('publishes missing-output processing events through the runtime host', async () => {
    const { events, host } = createRecordingHost();
    const roundData = new Map<number, RoundData>();
    const logger = {
      debug: () => {},
      domain: () => {},
    } as unknown as AgentTrace;
    const xmlManager = {
      processSingleXmlOutput: async () => {
        throw new Error('invalid xml');
      },
    } as unknown as XmlOutputManager;
    const ensureRound = (round: number): RoundData => {
      let data = roundData.get(round);
      if (!data) {
        data = {
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
        documentTag: 'latex_document',
      } as ProcessingContext['agentSetting'],
      baseFiles: [],
      streamId: 'stream:processor',
      runtimeHost: host,
      logger,
      xmlManager,
      setRoundOutputs,
      ensureRoundData: ensureRound,
    };

    await new OutputFileProcessor(context).processSingleOutput(
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
});
