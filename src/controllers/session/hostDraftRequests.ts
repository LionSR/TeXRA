/** Shared draft operations and the process recorder's originating request. */
import pDefer from 'p-defer';

import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { polishTextWithAI } from '@agent/runtime/textEnhancement';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import { Cancelled, Rejected } from '@shared/session/requestErrors';
import type { HostOutcome } from '@shared/session/sessionFrames';
import {
  killActiveRecording,
  startRecording,
  stopRecordingAndTranscribe,
} from '@tools/media/audio';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

type DraftRequest = Extract<
  HostRequest,
  { kind: 'record' | 'polish' | 'savePastedImage' }
>;
type Recording = NonNullable<HostSnapshot['recording']>;

interface Take {
  readonly session: SessionHandle;
  readonly port: string;
  readonly descriptor: Recording;
  readonly result: ReturnType<typeof pDefer<HostOutcome>>;
  ready: Promise<void>;
  stopping: boolean;
  cancelled: boolean;
}

/** One instance per host process, shared by its session request handlers. */
export class HostDraftRequests {
  private take: Take | null = null;
  private readonly listeners = new Set<(recording: Recording | null) => void>();

  /** Bind one session's requests, recorder level, and disposal together. */
  attach(
    session: SessionHandle,
    onRecording: (recording: Recording | null) => void,
  ) {
    const stopObserving = this.subscribe(onRecording);
    return {
      handle: (request: DraftRequest, port: string) =>
        this.handle(session, request, port),
      closePort: (port: string) => this.cancel(session, port),
      dispose: () => {
        stopObserving();
        this.cancel(session);
      },
    };
  }

  /** Every open paper observes the same recorder and its destination. */
  subscribe(listener: (recording: Recording | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.recording());
    return () => this.listeners.delete(listener);
  }

  async handle(
    session: SessionHandle,
    request: DraftRequest,
    port: string,
  ): Promise<HostOutcome> {
    switch (request.kind) {
      case 'polish': {
        const result = await polishTextWithAI(request.text, undefined, session);
        if (!result.success) {
          throw new Rejected({ reason: result.error ?? 'Polishing failed.' });
        }
        return { kind: 'text', text: result.text };
      }
      case 'savePastedImage':
        return {
          kind: 'savedImage',
          fileName: await savePastedImageBase64(
            request.base64,
            request.fileName,
          ),
        };
      case 'record':
        if (request.action.kind === 'start') {
          return this.start(session, port, request.action.target);
        }
        this.stop();
        return { kind: 'done' };
    }
  }

  /** Closing the originating session discards its take without transcription. */
  cancel(session: SessionHandle, port?: string): void {
    const take = this.take;
    if (
      !take ||
      take.session !== session ||
      (port !== undefined && take.port !== port)
    )
      return;
    take.cancelled = true;
    take.result.reject(new Cancelled());
    this.notify();
    if (take.stopping) return;
    void take.ready.then(() => {
      if (this.take !== take) return;
      killActiveRecording();
      this.release(take);
    });
  }

  private start(
    session: SessionHandle,
    port: string,
    target: string,
  ): Promise<HostOutcome> {
    if (this.take) {
      throw new Rejected({ reason: 'A recording is already in progress.' });
    }
    const take: Take = {
      session,
      port,
      descriptor: { session: session.roots.storage, target },
      result: pDefer<HostOutcome>(),
      ready: Promise.resolve(),
      stopping: false,
      cancelled: false,
    };
    // Reserve the process recorder before asynchronous microphone startup.
    this.take = take;
    this.notify();
    take.ready = Promise.resolve(
      runInSession(session, async () => {
        const result = await startRecording();
        if (!result.success) {
          throw new Rejected({
            reason: result.error ?? 'Recording could not start.',
          });
        }
      }),
    ).catch((error: unknown) => {
      take.result.reject(error);
      this.release(take);
    });
    return take.result.promise;
  }

  private stop(): void {
    const take = this.take;
    if (!take || take.stopping || take.cancelled) return;
    take.stopping = true;
    this.notify();
    // Stop acknowledges its own request. Completion belongs to Start, even
    // when another paper or view stops the recorder.
    void take.ready.then(async () => {
      if (this.take !== take) return;
      try {
        if (take.cancelled) {
          killActiveRecording();
          return;
        }
        const result = await runInSession(
          take.session,
          stopRecordingAndTranscribe,
        );
        if (!result.success) {
          throw new Rejected({
            reason: result.error ?? 'Transcription failed.',
          });
        }
        take.result.resolve({ kind: 'text', text: result.text });
      } catch (error) {
        take.result.reject(error);
      } finally {
        this.release(take);
      }
    });
  }

  private recording(): Recording | null {
    const take = this.take;
    return take && !take.stopping && !take.cancelled ? take.descriptor : null;
  }

  private notify(): void {
    const recording = this.recording();
    for (const listener of this.listeners) listener(recording);
  }

  private release(take: Take): void {
    if (this.take !== take) return;
    this.take = null;
    this.notify();
  }
}
