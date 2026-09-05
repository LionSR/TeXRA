/**
 * One transport port of a session (PRD one-fold-three-renderers, 7.4, 8):
 * a webview (the sidebar or the editor tab) on one side, the session
 * runtime on the other. Up, the port carries the three messages of 8.2 to
 * 8.3 and the `Subscribe` of 8.1; down, the frames one `Subscribe` starts,
 * one `Response` per request, and the host's surface actions.
 *
 * The provider owns the webview and the port's lifetime: it hands the
 * bridge every message the webview posts and calls `close` when the webview
 * goes away, which interrupts the framer, removes the port's transcript
 * set, and stops a recording the port owns.
 */
import * as vscode from 'vscode';
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { frameSubscription } from '@controllers/session/SessionFramer';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { RequestError } from '@shared/session/requestErrors';
import {
  UpMessageSchema,
  type DownMessage,
  type HostOutcome,
  type RequestErrorWire,
  type Response,
  type Subscribe,
} from '@shared/session/sessionFrames';

const log = createLog('SessionBridge');

function toWire(error: RequestError): RequestErrorWire {
  switch (error._tag) {
    case 'NotOwner':
      return { _tag: 'NotOwner', streamId: error.streamId };
    case 'Unavailable':
      return {
        _tag: 'Unavailable',
        streamId: error.streamId,
        reason: error.reason,
      };
    case 'Rejected':
      return { _tag: 'Rejected', reason: error.reason };
  }
}

export interface SessionBridgeOptions {
  readonly session: SessionHandle;
  /** The port's name in the session's transcript-subscription union. */
  readonly port: string;
  /** The host snapshot level this port frames (8.1). */
  readonly host: SubscriptionRef.SubscriptionRef<HostSnapshot | null>;
  /** The host capabilities of 8.3, one switch over the managers. */
  readonly hostRequest: (
    request: HostRequest,
    port: string,
  ) => Promise<HostOutcome>;
  readonly webview: vscode.Webview;
}

export class SessionBridge {
  private framer: Fiber.Fiber<void, never> | undefined;

  constructor(private readonly options: SessionBridgeOptions) {}

  /** Route one message the webview posted. */
  handleMessage(raw: unknown): void {
    const parsed = UpMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('Dropped a webview message that is not on the protocol', {
        data: parsed.error.issues.slice(0, 3),
      });
      return;
    }
    const message = parsed.data;
    switch (message.kind) {
      case 'subscribe':
        this.subscribe(message);
        return;
      case 'runtime.request':
        void effectRuntime()
          .runPromise(
            this.options.session.requests.request(message.request).pipe(
              Effect.map((outcome): Response['result'] => ({
                ok: true,
                outcome,
              })),
              Effect.catchTags({
                NotOwner: (error) =>
                  Effect.succeed<Response['result']>({
                    ok: false,
                    error: toWire(error),
                  }),
                Unavailable: (error) =>
                  Effect.succeed<Response['result']>({
                    ok: false,
                    error: toWire(error),
                  }),
                Rejected: (error) =>
                  Effect.succeed<Response['result']>({
                    ok: false,
                    error: toWire(error),
                  }),
              }),
            ),
          )
          .then((result) => this.respond(message.requestId, result));
        return;
      case 'host.request':
        void this.options
          .hostRequest(message.request, this.options.port)
          .then(
            (outcome): Response['result'] => ({ ok: true, outcome }),
            (error: unknown): Response['result'] => ({
              ok: false,
              error: {
                _tag: 'Rejected',
                reason: error instanceof Error ? error.message : String(error),
              },
            }),
          )
          .then((result) => this.respond(message.requestId, result));
        return;
    }
  }

  /** The host acting on state the surface owns (8.5). */
  surfaceAction(
    action: Extract<DownMessage, { kind: 'surface.action' }>['action'],
  ): void {
    void this.post({
      kind: 'surface.action',
      session: this.options.session.roots.storage,
      action,
    });
  }

  /** Answer this `Subscribe`: the previous replay, if any, is superseded. */
  private subscribe(subscribe: Subscribe): void {
    const { session, port, host } = this.options;
    this.interruptFramer();
    const frames = frameSubscription(
      {
        key: session.roots.storage,
        view: session.view,
        events: session.events,
        local: session.local,
        chunks: session.chunks,
        setTranscriptSubscriptions: (name, set) =>
          Effect.sync(() => session.setTranscriptSubscriptions(name, set)),
      },
      port,
      host,
      subscribe,
    );
    this.framer = effectRuntime().runFork(
      Stream.runForEach(frames, (frame) =>
        Effect.promise(() => this.post(frame)),
      ),
    );
  }

  private respond(requestId: string, result: Response['result']): void {
    void this.post({
      kind: 'response',
      session: this.options.session.roots.storage,
      requestId,
      result,
    });
  }

  private post(message: DownMessage): Promise<void> {
    return Promise.resolve(this.options.webview.postMessage(message)).then(
      (delivered) => {
        if (!delivered) {
          log.warn(
            `A ${message.kind} message was not delivered to port ${this.options.port}`,
          );
        }
      },
    );
  }

  private interruptFramer(): void {
    const framer = this.framer;
    this.framer = undefined;
    if (framer) effectRuntime().runFork(Fiber.interrupt(framer));
  }

  /** The webview went away: no frames, no transcript hold, no recording. */
  close(): void {
    this.interruptFramer();
    this.options.session.setTranscriptSubscriptions(this.options.port, []);
  }
}
