// Node imports
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { ProcessExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  ProcessOutputPoller,
  type ProcessOutputEmitter,
} from '@agent/runtime/ProcessOutputPoller';

// Local imports - shared
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { StreamTabId } from '@shared/schemas';
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

    await poller.flush(handle);

    expect(events).toEqual([outputEvent('\uFFFD', '')]);
  });
});
