import { StringDecoder } from 'node:string_decoder';

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

interface FileReadState {
  offset: number;
  decoder: StringDecoder;
}

interface OutputState {
  stdout: FileReadState;
  stderr: FileReadState;
}

export class ProcessOutputPoller {
  /** Tracks byte offsets and UTF-8 decoder state per executionId. */
  private readonly outputStates = new Map<string, OutputState>();

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
    this.outputStates.delete(executionId);
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

    // Flush any incomplete UTF-8 sequences that StringDecoder buffered
    // internally when the file stopped growing mid-sequence.
    const state = this.outputStates.get(handle.executionId);
    if (state) {
      const outTail = state.stdout.decoder.end();
      const errTail = state.stderr.decoder.end();
      if (outTail || errTail) {
        runtimeHost.emit('updateProcessOutput', {
          parentStreamId: handle.parentStreamId,
          executionId: handle.executionId,
          stdout: outTail,
          stderr: errTail,
        });
      }
    }
  }

  dispose(): void {
    if (this.outputPollTimer) {
      clearTimeout(this.outputPollTimer);
      this.outputPollTimer = null;
    }
    this.outputStates.clear();
    this.processOutputs.clear();
    this.readingInProgress.clear();
    this.pollInFlight = false;
  }

  private getOrCreateState(executionId: string): OutputState {
    let state = this.outputStates.get(executionId);
    if (!state) {
      state = {
        stdout: { offset: 0, decoder: new StringDecoder('utf8') },
        stderr: { offset: 0, decoder: new StringDecoder('utf8') },
      };
      this.outputStates.set(executionId, state);
    }
    return state;
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
        const state = this.getOrCreateState(executionId);
        const [outText, errText] = await Promise.all([
          readTail(stdoutPath, state.stdout).catch(() => ''),
          readTail(stderrPath, state.stderr).catch(() => ''),
        ]);
        if (!outText && !errText) return;

        runtimeHost.emit('updateProcessOutput', {
          parentStreamId,
          executionId,
          stdout: outText,
          stderr: errText,
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
 * Read new bytes from a file starting at `state.offset`, decode as UTF-8
 * (StringDecoder buffers any trailing incomplete multibyte sequence internally
 * and completes it on the next call), advance the offset, and return the text.
 */
async function readTail(path: string, state: FileReadState): Promise<string> {
  const { size } = await platform().fs.stat(path);
  if (size <= state.offset) return '';

  const toRead = Math.min(size - state.offset, MAX_READ_PER_POLL);
  const bytes = await platform().fs.readFileChunk(path, state.offset, toRead);
  const buf = Buffer.from(bytes);
  state.offset += buf.length;
  return state.decoder.write(buf);
}

export const processOutputPoller = new ProcessOutputPoller();
