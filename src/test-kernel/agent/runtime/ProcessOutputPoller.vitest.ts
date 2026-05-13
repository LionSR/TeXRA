// Node imports
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { ProcessExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  flushProcessOutput,
  registerProcessOutput,
  unregisterProcessOutput,
} from '@agent/runtime/ProcessOutputPoller';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

const tmpDirs: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRuntimeHost(): {
  host: AgentRuntimeHost;
  events: Array<{ event: string; payload: unknown }>;
} {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    host: {
      emit: vi.fn((event: string, payload: unknown) => {
        events.push({ event, payload });
      }) as AgentRuntimeHost['emit'],
    },
  };
}

async function makeProcessHandle(
  runtimeHost: AgentRuntimeHost,
  options: { assignOutputPaths?: boolean } = {},
): Promise<{
  handle: ProcessExecutionHandle;
  stdoutPath: string;
  stderrPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-poller-'));
  tmpDirs.push(dir);
  const stdoutPath = path.join(dir, 'stdout.log');
  const stderrPath = path.join(dir, 'stderr.log');
  await fs.writeFile(stdoutPath, 'out-1');
  await fs.writeFile(stderrPath, 'err-1');

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
  unregisterProcessOutput('exec-1');
  vi.useRealTimers();
  await Promise.all(
    tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe('ProcessOutputPoller', () => {
  it('flushes only new process output bytes', async () => {
    const { host, events } = createRuntimeHost();
    const { handle, stdoutPath, stderrPath } = await makeProcessHandle(host);

    await flushProcessOutput(handle, host);
    await fs.appendFile(stdoutPath, 'out-2');
    await fs.appendFile(stderrPath, 'err-2');
    await flushProcessOutput(handle, host);

    expect(events).toEqual([
      {
        event: 'updateProcessOutput',
        payload: {
          parentStreamId: 'parent-stream',
          executionId: 'exec-1',
          stdout: 'out-1',
          stderr: 'err-1',
        },
      },
      {
        event: 'updateProcessOutput',
        payload: {
          parentStreamId: 'parent-stream',
          executionId: 'exec-1',
          stdout: 'out-2',
          stderr: 'err-2',
        },
      },
    ]);
  });

  it('polls handles whose output paths are assigned after registration', async () => {
    const { host, events } = createRuntimeHost();
    const { handle, stdoutPath, stderrPath } = await makeProcessHandle(host, {
      assignOutputPaths: false,
    });

    registerProcessOutput(handle, host);
    handle.outputPaths = { stdout: stdoutPath, stderr: stderrPath };

    await delay(550);
    await fs.appendFile(stdoutPath, 'out-2');
    await fs.appendFile(stderrPath, 'err-2');
    await delay(550);

    expect(events).toEqual([
      {
        event: 'updateProcessOutput',
        payload: {
          parentStreamId: 'parent-stream',
          executionId: 'exec-1',
          stdout: 'out-1',
          stderr: 'err-1',
        },
      },
      {
        event: 'updateProcessOutput',
        payload: {
          parentStreamId: 'parent-stream',
          executionId: 'exec-1',
          stdout: 'out-2',
          stderr: 'err-2',
        },
      },
    ]);
  });
});
