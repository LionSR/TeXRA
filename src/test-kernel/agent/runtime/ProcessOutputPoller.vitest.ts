// Node imports
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { ProcessExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  ProcessOutputPoller,
  type ProcessOutputEmitter,
} from '@agent/runtime/ProcessOutputPoller';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { StreamTabId } from '@shared/schemas';
import { PROCESS_OUTPUT_MAX_CHARS } from '@shared/streams/streamMetaReducer';
import { setupPlatform } from '@test/support/setupPlatform';
import { delay } from '@utils/core';

const tmpDirs: string[] = [];
let poller: ProcessOutputPoller;

function createRuntimeHost(): {
  host: AgentRuntimeHost;
  events: Array<{ event: string; payload: unknown }>;
  emitOutput: (emitOutput: ProcessOutputEmitter) => void;
} {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    emitOutput: (emitOutput) => {
      poller.setOutputEmitter(emitOutput);
    },
    host: {
      emit: vi.fn((event: string, payload: unknown) => {
        events.push({ event, payload });
      }) as AgentRuntimeHost['emit'],
    },
  };
}

function outputEvent(stdout: string, stderr: string) {
  return {
    event: 'process.output',
    payload: {
      parentStreamId: 'parent-stream',
      executionId: 'exec-1',
      stdout,
      stderr,
    },
  };
}

async function makeProcessHandle(
  runtimeHost: AgentRuntimeHost,
  options: {
    assignOutputPaths?: boolean;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  } = {},
): Promise<{
  handle: ProcessExecutionHandle;
  stdoutPath: string;
  stderrPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-poller-'));
  tmpDirs.push(dir);
  const stdoutPath = path.join(dir, 'stdout.log');
  const stderrPath = path.join(dir, 'stderr.log');
  await fs.writeFile(stdoutPath, options.stdout ?? 'out-1');
  await fs.writeFile(stderrPath, options.stderr ?? 'err-1');

  const handle = new ProcessExecutionHandle(
    'exec-1',
    'parent-stream' as StreamTabId,
    'bash',
    () => true,
    runtimeHost,
  );
  if (options.assignOutputPaths !== false) {
    handle.outputPaths = { stdout: stdoutPath, stderr: stderrPath };
  }
  return { handle, stdoutPath, stderrPath };
}

afterEach(async () => {
  poller.dispose();
  vi.useRealTimers();
  await Promise.all(
    tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe('ProcessOutputPoller', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  beforeEach(() => {
    poller = new ProcessOutputPoller();
  });

  it('flushes only new process output bytes', async () => {
    const { host, events, emitOutput } = createRuntimeHost();
    emitOutput((payload) => events.push({ event: 'process.output', payload }));
    const { handle, stdoutPath, stderrPath } = await makeProcessHandle(host);

    await poller.flush(handle);
    await fs.appendFile(stdoutPath, 'out-2');
    await fs.appendFile(stderrPath, 'err-2');
    await poller.flush(handle);

    expect(events).toEqual([
      outputEvent('out-1', 'err-1'),
      outputEvent('out-2', 'err-2'),
    ]);
  });

  it('accumulates incremental stdout and stderr snapshots in order', async () => {
    const { host, emitOutput } = createRuntimeHost();
    emitOutput(vi.fn());
    const { handle, stdoutPath, stderrPath } = await makeProcessHandle(host);
    poller.register(handle);

    await poller.flush(handle);
    await fs.appendFile(stdoutPath, 'out-2');
    await fs.appendFile(stderrPath, 'err-2');
    await poller.flush(handle);

    expect(poller.getActiveOutputSnapshots().get(handle.executionId)).toEqual({
      stdout: 'out-1out-2',
      stderr: 'err-1err-2',
    });
  });

  it('retains exactly the shared per-process output bound', async () => {
    const { host, emitOutput } = createRuntimeHost();
    emitOutput(vi.fn());
    const stdout = `discard${'o'.repeat(PROCESS_OUTPUT_MAX_CHARS)}`;
    const stderr = `discard${'e'.repeat(PROCESS_OUTPUT_MAX_CHARS)}`;
    const { handle } = await makeProcessHandle(host, { stdout, stderr });
    poller.register(handle);

    await poller.flush(handle);

    const snapshot = poller.getActiveOutputSnapshots().get(handle.executionId);
    expect(snapshot?.stdout).toBe('o'.repeat(PROCESS_OUTPUT_MAX_CHARS));
    expect(snapshot?.stderr).toBe('e'.repeat(PROCESS_OUTPUT_MAX_CHARS));
  });

  it('returns detached immutable snapshots', async () => {
    const { host, emitOutput } = createRuntimeHost();
    emitOutput(vi.fn());
    const { handle } = await makeProcessHandle(host);
    poller.register(handle);
    await poller.flush(handle);

    const snapshots = poller.getActiveOutputSnapshots();
    const output = snapshots.get(handle.executionId);
    (snapshots as Map<string, unknown>).clear();
    expect(() => {
      (output as { stdout: string }).stdout = 'mutated';
    }).toThrow(TypeError);

    expect(poller.getActiveOutputSnapshots().get(handle.executionId)).toEqual({
      stdout: 'out-1',
      stderr: 'err-1',
    });
  });

  it('clears snapshots on unregister and dispose', async () => {
    const { host, emitOutput } = createRuntimeHost();
    emitOutput(vi.fn());
    const { handle } = await makeProcessHandle(host);
    poller.register(handle);
    await poller.flush(handle);

    poller.unregister(handle.executionId);
    expect(poller.getActiveOutputSnapshots()).toEqual(new Map());

    poller.register(handle);
    await poller.flush(handle);
    poller.dispose();
    expect(poller.getActiveOutputSnapshots()).toEqual(new Map());
  });

  it('polls handles whose output paths are assigned after registration', async () => {
    const { host, events, emitOutput } = createRuntimeHost();
    emitOutput((payload) => events.push({ event: 'process.output', payload }));
    const { handle, stdoutPath, stderrPath } = await makeProcessHandle(host, {
      assignOutputPaths: false,
    });

    poller.register(handle);
    handle.outputPaths = { stdout: stdoutPath, stderr: stderrPath };

    await delay(550);
    await fs.appendFile(stdoutPath, 'out-2');
    await fs.appendFile(stderrPath, 'err-2');
    await delay(550);

    expect(events).toEqual([
      outputEvent('out-1', 'err-1'),
      outputEvent('out-2', 'err-2'),
    ]);
  });

  it('keeps output offsets per instance', async () => {
    const { host, events, emitOutput } = createRuntimeHost();
    emitOutput((payload) => events.push({ event: 'process.output', payload }));
    const { handle } = await makeProcessHandle(host);
    const otherPoller = new ProcessOutputPoller();
    otherPoller.setOutputEmitter((payload) =>
      events.push({ event: 'process.output', payload }),
    );

    try {
      await poller.flush(handle);
      await otherPoller.flush(handle);
    } finally {
      otherPoller.dispose();
    }

    expect(events).toEqual([
      outputEvent('out-1', 'err-1'),
      outputEvent('out-1', 'err-1'),
    ]);
  });

  it('flushes buffered incomplete UTF-8 when process output ends', async () => {
    const { host, events, emitOutput } = createRuntimeHost();
    emitOutput((payload) => events.push({ event: 'process.output', payload }));
    const incompleteEmoji = Buffer.from('🙂').subarray(0, 2);
    const { handle } = await makeProcessHandle(host, {
      stdout: incompleteEmoji,
      stderr: '',
    });
    poller.register(handle);

    await poller.flush(handle);

    expect(events).toEqual([outputEvent('\uFFFD', '')]);
    expect(poller.getActiveOutputSnapshots().get(handle.executionId)).toEqual({
      stdout: '\uFFFD',
      stderr: '',
    });
  });
});
