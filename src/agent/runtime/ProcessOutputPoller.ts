import { StringDecoder } from 'node:string_decoder';

import pMap from 'p-map';

import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  PROCESS_OUTPUT_MAX_CHARS,
  type StreamProcessOutput,
} from '@shared/streams/streamMetaReducer';
import { delay } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { appendTail } from '@utils/strings/appendTail';

import type { ProcessExecutionHandle } from './ExecutionHandle';

interface ProcessOutputSource {
  handle: ProcessExecutionHandle;
}

export interface ProcessOutputPayload {
  readonly parentStreamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessOutputEmitter = (payload: ProcessOutputPayload) => void;

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
  output: StreamProcessOutput;
}

export class ProcessOutputPoller {
  /** Tracks byte offsets and UTF-8 decoder state per executionId. */
  private readonly outputStates = new Map<string, OutputState>();

  private readonly processOutputs = new Map<string, ProcessOutputSource>();
  private readonly readingInProgress = new Map<string, Promise<void>>();
  private loopController: AbortController | null = null;
  private emitOutput: ProcessOutputEmitter | undefined;

  constructor(emitOutput?: ProcessOutputEmitter) {
    this.emitOutput = emitOutput;
  }

  setOutputEmitter(emitOutput: ProcessOutputEmitter): void {
    this.emitOutput = emitOutput;
  }

  register(handle: ProcessExecutionHandle): void {
    this.processOutputs.set(handle.executionId, {
      handle,
    });
    this.getOrCreateState(handle.executionId);
    this.reconcile();
  }

  /** Return detached stdout/stderr tails for every currently active process. */
  getActiveOutputSnapshots(): ReadonlyMap<ExecutionId, StreamProcessOutput> {
    const snapshots = new Map<ExecutionId, StreamProcessOutput>();
    for (const executionId of this.processOutputs.keys()) {
      const output = this.outputStates.get(executionId)?.output ?? {
        stdout: '',
        stderr: '',
      };
      snapshots.set(executionId, Object.freeze({ ...output }));
    }
    return snapshots;
  }

  unregister(executionId: string): void {
    this.processOutputs.delete(executionId);
    this.outputStates.delete(executionId);
    this.reconcile();
  }

  async flush(handle: ProcessExecutionHandle): Promise<void> {
    if (!handle.outputPaths) return;

    await this.readIncremental(
      handle.executionId,
      handle.parentStreamId,
      handle.outputPaths.stdout,
      handle.outputPaths.stderr,
    );

    // Flush any incomplete UTF-8 sequences that StringDecoder buffered
    // internally when the file stopped growing mid-sequence.
    const state = this.outputStates.get(handle.executionId);
    if (state) {
      const outTail = state.stdout.decoder.end();
      const errTail = state.stderr.decoder.end();
      // Reset decoders so a subsequent flush() or poll can call decoder.write()
      // safely — Node.js docs treat write() after end() as undefined behavior.
      state.stdout.decoder = new StringDecoder('utf8');
      state.stderr.decoder = new StringDecoder('utf8');
      if (outTail || errTail) {
        this.emitProcessOutput({
          parentStreamId: handle.parentStreamId,
          executionId: handle.executionId,
          stdout: outTail,
          stderr: errTail,
        });
      }
    }
  }

  dispose(): void {
    this.loopController?.abort();
    this.loopController = null;
    this.outputStates.clear();
    this.processOutputs.clear();
    this.readingInProgress.clear();
  }

  private getOrCreateState(executionId: string): OutputState {
    let state = this.outputStates.get(executionId);
    if (!state) {
      state = {
        stdout: { offset: 0, decoder: new StringDecoder('utf8') },
        stderr: { offset: 0, decoder: new StringDecoder('utf8') },
        output: { stdout: '', stderr: '' },
      };
      this.outputStates.set(executionId, state);
    }
    return state;
  }

  private reconcile(): void {
    const active = this.processOutputs.size > 0;
    if (active && !this.loopController) {
      const controller = new AbortController();
      this.loopController = controller;
      void this.runPollLoop(controller.signal);
    } else if (!active && this.loopController) {
      // Abort but do NOT null loopController here: the loop may still be
      // inside pollProcessOutputs(). Nulling immediately lets a concurrent
      // register() start a second loop before the first exits, producing
      // duplicate reads. runPollLoop's cleanup nulls the field after the
      // loop body exits and then calls reconcile() to restart if needed.
      this.loopController.abort();
    }
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await delay(OUTPUT_POLL_INTERVAL_MS, { signal });
      } catch {
        break; // AbortError: stop requested
      }
      try {
        await this.pollProcessOutputs();
      } catch (err) {
        logger.debug(
          'ProcessOutputPoller',
          `Poll tick failed unexpectedly: ${toErrorMessage(err)}`,
        );
      }
    }
    // Null the controller so reconcile() can start a fresh loop if processes
    // were registered while this loop was winding down after an abort.
    // dispose() sets loopController = null before this runs, so the guard
    // evaluates false and reconcile() is not called during teardown.
    if (this.loopController?.signal === signal) {
      this.loopController = null;
      this.reconcile();
    }
  }

  private async pollProcessOutputs(): Promise<void> {
    await pMap(
      [...this.processOutputs.values()],
      (source) => {
        const { outputPaths } = source.handle;
        if (!outputPaths) return Promise.resolve();
        // Poll reads are gated on the process still being registered
        // (requireRegistered=true): the snapshot above is taken before pMap
        // drains it, and a process can be unregistered while its read is
        // queued. Recreating decoder state for a dead process would orphan an
        // outputStates entry that no future unregister clears. The flush() path
        // owns its handle and reads with the default requireRegistered=false.
        return this.readIncremental(
          source.handle.executionId,
          source.handle.parentStreamId,
          outputPaths.stdout,
          outputPaths.stderr,
          true,
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
    requireRegistered = false,
  ): Promise<void> {
    const inflight = this.readingInProgress.get(executionId);
    if (inflight) {
      await inflight;
    }

    // Re-check registration AFTER awaiting any in-flight read: that read may be
    // the terminal flush() whose .finally(unregister) deletes this process's
    // state, and recreating it below (getOrCreateState) would orphan a decoder
    // entry no future unregister clears. flush() itself passes
    // requireRegistered=false so it still runs after unregister.
    if (requireRegistered && !this.processOutputs.has(executionId)) {
      return;
    }

    const work = (async () => {
      try {
        const state = this.getOrCreateState(executionId);
        const [outText, errText] = await Promise.all([
          readTail(stdoutPath, state.stdout).catch(() => ''),
          readTail(stderrPath, state.stderr).catch(() => ''),
        ]);
        if (!outText && !errText) return;

        this.emitProcessOutput({
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
          `Process output read failed for ${executionId}: ${toErrorMessage(
            err,
          )}`,
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

  private emitProcessOutput(payload: ProcessOutputPayload): void {
    if (!this.emitOutput) {
      throw new Error('ProcessOutputPoller requires a process output emitter');
    }
    this.emitOutput(payload);

    // The emitter may synchronously unregister the process. Never recreate a
    // tail after unregister/dispose has pruned it.
    const state = this.outputStates.get(payload.executionId);
    if (!state || !this.processOutputs.has(payload.executionId)) return;
    state.output = {
      stdout: appendTail(
        state.output.stdout,
        payload.stdout,
        PROCESS_OUTPUT_MAX_CHARS,
      ),
      stderr: appendTail(
        state.output.stderr,
        payload.stderr,
        PROCESS_OUTPUT_MAX_CHARS,
      ),
    };
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
