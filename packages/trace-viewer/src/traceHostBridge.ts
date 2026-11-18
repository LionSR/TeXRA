/**
 * The trace viewer's host: a page-local
 * `HostBridgeApi` installed at module evaluation, before the progress bundle
 * resolves its bridge, so the unchanged webview runs against an exported
 * trace exactly as it runs against a live host. It serves the session's
 * procedures (`SessionRpcs`) over the page's own messages: `session.frames`
 * is answered with the one frame `traceFrame` cuts once the document has
 * loaded, `session.host` with the trace's snapshot, `session.actions` with
 * a selection of the run, so the shell opens on its conversation rather
 * than the New-task state, and a request is refused, since an exported
 * trace is read-only.
 *
 * The scrubber's cut is page state the bridge holds: every frame is cut at
 * the current one, and moving it remounts the shell (`main.ts`), whose
 * fresh client asks again. The document itself never changes.
 *
 * The document loads two ways: inline (`window.__TEXRA_TRACE__`, set by the
 * CLI export so the page is one self-contained file: `fetch()` of a local
 * file fails under `file://`), or a fetched `trace.json` beside the page
 * (the default over http). Both are externally authored, so both pass the
 * same `parseTraceData` boundary.
 */
import { Effect, Result, Schema, Stream } from 'effect';
import { RpcServer, type RpcMessage } from 'effect/rpc';

import { Rejected, type TraceDocument } from '@texra-ai/harness/schemas';
import {
  SessionEnvelopeSchema,
  SessionRpcs,
  type SessionWire,
} from '@texra/shared/session/sessionFrames';
import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@texra/shared/hostBridgeTypes';
import { serveOverMessages } from '@texra/shared/rpcOverMessages';

import { parseTraceData } from './traceDataSchema';
import { traceFrame, traceHost } from './traceFrames';

// The inline trace `standaloneTraceHtml` writes into the exported page.
declare global {
  var __TEXRA_TRACE__: unknown;
}

/** The session key the page's `<progress-app data-session>` names. */
const TRACE_SESSION = 'trace';

async function loadTrace(): Promise<TraceDocument> {
  const inline = globalThis.__TEXRA_TRACE__;
  if (inline) {
    // Once consumed, drop the raw copy: nothing else reads this global.
    globalThis.__TEXRA_TRACE__ = undefined;
    return parseTraceData(inline);
  }
  const params = new URLSearchParams(window.location.search);
  const file = params.get('trace') ?? 'trace.json';
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: ${res.status}`);
  return parseTraceData(await res.json());
}

/** The `run.position` index the view is read at; null is the whole document. */
let cut: number | null = null;

/**
 * Move the scrubber: frames are cut at `index` from here on, and the next
 * mount opens the run again.
 */
export function setTraceCut(index: number | null): void {
  cut = index;
}

/** The procedures over the trace. A call made before the document loads
 *  waits for it; one made after it failed to load gets nothing, since the
 *  entry renders the load failure. */
function traceHandlers(document: Promise<TraceDocument>) {
  const loaded = Stream.fromEffect(
    Effect.promise(() =>
      document.then(
        (trace) => trace,
        () => null,
      ),
    ),
  ).pipe(Stream.filter((trace) => trace !== null));
  const refused = Effect.fail(
    new Rejected({ reason: 'An exported trace is read-only.' }),
  );
  return SessionRpcs.toLayer({
    'session.frames': (subscribe) =>
      Stream.map(loaded, (trace) => traceFrame(trace, subscribe, cut)),
    'session.host': () => Stream.map(loaded, traceHost),
    'session.actions': () =>
      Stream.map(loaded, (trace) => ({
        kind: 'select' as const,
        runId: trace.runId,
      })),
    'session.request': () => refused,
    'host.request': () => refused,
  });
}

function installTraceHostBridge(document: Promise<TraceDocument>): void {
  let state: unknown;
  const deliver = (message: SessionWire): void => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  };
  // The page's one server, for its life (the page is this host's root);
  // each mount of the shell is a new client of it.
  const served = Effect.runSync(
    serveOverMessages((client, message) =>
      Effect.sync(() => deliver({ session: TRACE_SESSION, client, message })),
    ),
  );
  Effect.runFork(
    RpcServer.make(SessionRpcs).pipe(
      Effect.provide(traceHandlers(document)),
      Effect.provideService(RpcServer.Protocol, served.protocol),
    ),
  );
  const bridge: HostBridgeApi = {
    postMessage(message) {
      const parsed = Schema.decodeUnknownResult(SessionEnvelopeSchema)(message);
      if (Result.isFailure(parsed)) {
        console.warn('[trace-viewer] unrecognized shell message', message);
        return;
      }
      const { client, message: rpc } = parsed.success;
      // cast: `rpc` reads its own message.
      Effect.runFork(
        served.receive(client, rpc as unknown as RpcMessage.FromClientEncoded),
      );
    },
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
  globalThis[HOST_BRIDGE_API_KEY] = bridge;
}

/** The document this page shows; the bridge serves it. */
export const trace: Promise<TraceDocument> = loadTrace();
installTraceHostBridge(trace);
