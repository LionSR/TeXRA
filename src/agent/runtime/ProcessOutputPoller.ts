// Node imports
import * as fs from 'fs';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

// Local imports - runtime
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { ProcessExecutionHandle } from './ExecutionHandle';

interface ProcessOutputSource {
  parentStreamId: StreamTabId;
  stdoutPath: string;
  stderrPath: string;
  runtimeHost: AgentRuntimeHost;
}

/** Interval at which temp files are read and pushed to the progress UI. */
const OUTPUT_POLL_INTERVAL_MS = 500;

/** Max bytes to read per file per poll to prevent huge allocations. */
const MAX_READ_PER_POLL = 128 * 1024;

/** Tracks byte offsets already sent per executionId per stream. */
const outputOffsets = new Map<string, { stdout: number; stderr: number }>();

const processOutputs = new Map<string, ProcessOutputSource>();

let outputPollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;

/**
 * Tracks in-flight reads per executionId so concurrent calls can await
 * rather than silently skipping final tail output.
 */
const readingInProgress = new Map<string, Promise<void>>();

export function registerProcessOutput(
  handle: ProcessExecutionHandle,
  runtimeHost: AgentRuntimeHost,
): void {
  if (!handle.outputPaths) return;

  processOutputs.set(handle.executionId, {
    parentStreamId: handle.parentStreamId,
    stdoutPath: handle.outputPaths.stdout,
    stderrPath: handle.outputPaths.stderr,
    runtimeHost,
  });
  reconcileOutputPoller();
}

export function unregisterProcessOutput(executionId: string): void {
  processOutputs.delete(executionId);
  outputOffsets.delete(executionId);
  reconcileOutputPoller();
}

export async function flushProcessOutput(
  handle: ProcessExecutionHandle,
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  if (!handle.outputPaths) return;

  await readIncremental(
    handle.executionId,
    handle.parentStreamId,
    handle.outputPaths.stdout,
    handle.outputPaths.stderr,
    runtimeHost,
  );
}

function reconcileOutputPoller(): void {
  const active = processOutputs.size > 0;
  if (active && !outputPollTimer) {
    schedulePoll();
  } else if (!active && outputPollTimer) {
    clearTimeout(outputPollTimer);
    outputPollTimer = null;
  }
}

/** Schedule the next poll cycle; the next poll waits for the current one. */
function schedulePoll(): void {
  outputPollTimer = setTimeout(async () => {
    outputPollTimer = null;
    if (pollInFlight) {
      schedulePoll();
      return;
    }
    pollInFlight = true;
    try {
      await pollProcessOutputs();
    } finally {
      pollInFlight = false;
      reconcileOutputPoller();
    }
  }, OUTPUT_POLL_INTERVAL_MS);
}

async function pollProcessOutputs(): Promise<void> {
  await Promise.all(
    [...processOutputs.entries()].map(([executionId, source]) =>
      readIncremental(
        executionId,
        source.parentStreamId,
        source.stdoutPath,
        source.stderrPath,
        source.runtimeHost,
      ),
    ),
  );
}

/**
 * Find the last byte index that ends a complete UTF-8 character.
 * If the buffer ends mid-character, those trailing bytes are excluded
 * so the next read starts at the right boundary.
 */
function lastCompleteUtf8(buf: Buffer, bytesRead: number): number {
  if (bytesRead === 0) return 0;
  // Walk backward (max 3 bytes: longest UTF-8 lead) looking for
  // a continuation byte. If we find a lead byte, check whether the
  // sequence is complete.
  for (let i = bytesRead - 1; i >= Math.max(0, bytesRead - 3); i--) {
    const b = buf[i];
    if (b < 0x80) return bytesRead;
    if ((b & 0xc0) === 0x80) continue;

    let seqLen: number;
    if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else if ((b & 0xf8) === 0xf0) seqLen = 4;
    else return bytesRead;

    return i + seqLen <= bytesRead ? bytesRead : i;
  }
  return bytesRead;
}

async function readTail(
  path: string,
  byteOffset: number,
): Promise<{ text: string; newOffset: number }> {
  const fh = await fs.promises.open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size <= byteOffset) return { text: '', newOffset: byteOffset };
    const toRead = Math.min(size - byteOffset, MAX_READ_PER_POLL);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, byteOffset);
    const safeEnd = lastCompleteUtf8(buf, bytesRead);
    return {
      text: buf.toString('utf-8', 0, safeEnd),
      newOffset: byteOffset + safeEnd,
    };
  } finally {
    await fh.close();
  }
}

async function readIncremental(
  executionId: string,
  parentStreamId: StreamTabId,
  stdoutPath: string,
  stderrPath: string,
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  const inflight = readingInProgress.get(executionId);
  if (inflight) {
    await inflight;
  }

  const work = (async () => {
    try {
      const prev = outputOffsets.get(executionId) ?? { stdout: 0, stderr: 0 };
      const [out, err] = await Promise.all([
        readTail(stdoutPath, prev.stdout).catch(() => ({
          text: '',
          newOffset: prev.stdout,
        })),
        readTail(stderrPath, prev.stderr).catch(() => ({
          text: '',
          newOffset: prev.stderr,
        })),
      ]);
      if (!out.text && !err.text) return;

      outputOffsets.set(executionId, {
        stdout: out.newOffset,
        stderr: err.newOffset,
      });

      runtimeHost.emit('updateProcessOutput', {
        parentStreamId,
        executionId,
        stdout: out.text,
        stderr: err.text,
      });
    } catch {
      // File may have been deleted between check and read.
    }
  })();

  readingInProgress.set(executionId, work);
  try {
    await work;
  } finally {
    if (readingInProgress.get(executionId) === work) {
      readingInProgress.delete(executionId);
    }
  }
}
