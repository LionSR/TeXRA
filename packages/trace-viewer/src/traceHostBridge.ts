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
import { FetchHttpClient, HttpClient } from 'effect/http';
import { RpcServer } from 'effect/rpc';

import {
  ensureError,
  Rejected,
  type TraceDocument,
} from '@texra-ai/worldline/schemas';
import {
  ClientEnvelopeSchema,
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

class TraceLoadFailed extends Schema.TaggedError<TraceLoadFailed>()(
  'TraceLoadFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  static from = (cause: unknown) =>
    new TraceLoadFailed({ message: ensureError(cause).message, cause });
}

const loadTrace = Effect.fn('traceViewer.loadTrace')(function* () {
  let raw = globalThis.__TEXRA_TRACE__;
  if (raw) {
    // Once consumed, drop the raw copy: nothing else reads this global.
    globalThis.__TEXRA_TRACE__ = undefined;
  } else {
    const params = new URLSearchParams(window.location.search);
    const file = params.get('trace') ?? 'trace.json';
    const url = yield* Effect.try({
      try: () => new URL(file, document.baseURI),
      catch: TraceLoadFailed.from,
    });
    const response = yield* HttpClient.get(url).pipe(
      Effect.mapError(TraceLoadFailed.from),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* new TraceLoadFailed({
        message: `Failed to fetch ${file}: ${response.status}`,
      });
    raw = yield* response.json.pipe(Effect.mapError(TraceLoadFailed.from));
  }
  return yield* Effect.try({
    try: () => parseTraceData(raw),
    catch: TraceLoadFailed.from,
  });
});

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
function traceHandlers(
  document: Effect.Effect<TraceDocument, TraceLoadFailed>,
) {
  const loaded = Stream.fromEffect(document).pipe(
    Stream.catch(() => Stream.empty),
  );
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

function installTraceHostBridge(
  document: Effect.Effect<TraceDocument, TraceLoadFailed>,
): void {
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
      const parsed = Schema.decodeUnknownResult(ClientEnvelopeSchema)(message);
      if (Result.isFailure(parsed)) {
        console.warn('[trace-viewer] unrecognized shell message', message);
        return;
      }
      const { client, message: rpc } = parsed.success;
      Effect.runFork(served.receive(client, rpc));
    },
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
  globalThis[HOST_BRIDGE_API_KEY] = bridge;
}

const traceDocument = Effect.runSync(
  Effect.cached(loadTrace().pipe(Effect.provide(FetchHttpClient.layer))),
);
/** The document this page shows; the bridge serves it. */
export const trace: Promise<TraceDocument> = Effect.runPromise(traceDocument);
installTraceHostBridge(traceDocument);
