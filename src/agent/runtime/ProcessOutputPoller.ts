import pMap from 'p-map';

import { platform } from '@platform/platform';
import * as logger from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { ProcessExecutionHandle } from './ExecutionHandle';

interface ProcessOutputSource {
  handle: ProcessExecutionHandle;
  runtimeHost: AgentRuntimeHost;
}

/** Interval at which temp files are read and pushed to the progress UI. */
const OUTPUT_POLL_INTERVAL_MS = 500;

/** Max bytes to read per file per poll to prevent huge allocations. */
const MAX_READ_PER_POLL = 128 * 1024;

/** Max process output sources read concurrently on each poll tick. */
const OUTPUT_POLL_CONCURRENCY = 8;

export class ProcessOutputPoller {
  /** Tracks byte offsets already sent per executionId per stream. */
  private readonly outputOffsets = new Map<
    string,
    { stdout: number; stderr: number }
  >();

  private readonly processOutputs = new Map<string, ProcessOutputSource>();
  private readonly readingInProgress = new Map<string, Promise<void>>();
  private outputPollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;

  register(
    handle: ProcessExecutionHandle,
    runtimeHost: AgentRuntimeHost,
  ): void {
    this.processOutputs.set(handle.executionId, {
      handle,
      runtimeHost,
    });
    this.reconcile();
  }

  unregister(executionId: string): void {
    this.processOutputs.delete(executionId);
    this.outputOffsets.delete(executionId);
    this.reconcile();
  }

  async flush(
    handle: ProcessExecutionHandle,
    runtimeHost: AgentRuntimeHost,
  ): Promise<void> {
    if (!handle.outputPaths) return;

    await this.readIncremental(
      handle.executionId,
      handle.parentStreamId,
      handle.outputPaths.stdout,
      handle.outputPaths.stderr,
      runtimeHost,
    );
  }

  dispose(): void {
    if (this.outputPollTimer) {
      clearTimeout(this.outputPollTimer);
      this.outputPollTimer = null;
    }
    this.outputOffsets.clear();
    this.processOutputs.clear();
    this.readingInProgress.clear();
    this.pollInFlight = false;
  }

  private reconcile(): void {
    const active = this.processOutputs.size > 0;
    if (active && !this.outputPollTimer) {
      this.schedule();
    } else if (!active && this.outputPollTimer) {
      clearTimeout(this.outputPollTimer);
      this.outputPollTimer = null;
    }
  }

  /** Schedule the next poll cycle; the next poll waits for the current one. */
  private schedule(): void {
    this.outputPollTimer = setTimeout(async () => {
      this.outputPollTimer = null;
      if (this.pollInFlight) {
        this.schedule();
        return;
      }
      this.pollInFlight = true;
      try {
        await this.pollProcessOutputs();
      } finally {
        this.pollInFlight = false;
        this.reconcile();
      }
    }, OUTPUT_POLL_INTERVAL_MS);
  }

  private async pollProcessOutputs(): Promise<void> {
    await pMap(
      [...this.processOutputs.values()],
      (source) => {
        const { outputPaths } = source.handle;
        if (!outputPaths) return Promise.resolve();
        return this.readIncremental(
          source.handle.executionId,
          source.handle.parentStreamId,
          outputPaths.stdout,
          outputPaths.stderr,
          source.runtimeHost,
        );
      },
      { concurrency: OUTPUT_POLL_CONCURRENCY },
    );
  }

  private async readIncremental(
    executionId: string,
    parentStreamId: StreamTabId,
    stdoutPath: string,
    stderrPath: string,
    runtimeHost: AgentRuntimeHost,
  ): Promise<void> {
    const inflight = this.readingInProgress.get(executionId);
    if (inflight) {
      await inflight;
    }

    const work = (async () => {
      try {
        const prev = this.outputOffsets.get(executionId) ?? {
          stdout: 0,
          stderr: 0,
        };
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

        this.outputOffsets.set(executionId, {
          stdout: out.newOffset,
          stderr: err.newOffset,
        });

        runtimeHost.emit('updateProcessOutput', {
          parentStreamId,
          executionId,
          stdout: out.text,
          stderr: err.text,
        });
      } catch (err) {
        // Benign race: file may have been deleted between check and read.
        // Log at debug so a persistent read failure is still observable.
        logger.debug(
          'ProcessOutputPoller',
          `Process output read failed for ${executionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();

    this.readingInProgress.set(executionId, work);
    try {
      await work;
    } finally {
      if (this.readingInProgress.get(executionId) === work) {
        this.readingInProgress.delete(executionId);
      }
    }
  }
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
  const { size } = await platform().fs.stat(path);
  if (size <= byteOffset) return { text: '', newOffset: byteOffset };

  const toRead = Math.min(size - byteOffset, MAX_READ_PER_POLL);
  const bytes = await platform().fs.readFileChunk(path, byteOffset, toRead);
  const buf = Buffer.from(bytes);
  const safeEnd = lastCompleteUtf8(buf, buf.length);
  return {
    text: buf.toString('utf-8', 0, safeEnd),
    newOffset: byteOffset + safeEnd,
  };
}

export const processOutputPoller = new ProcessOutputPoller();
