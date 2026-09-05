/**
 * The trace viewer's host (PRD one-fold-three-renderers, 7.7): a page-local
 * `HostBridgeApi` installed at module evaluation, before the progress bundle
 * resolves its bridge, so the unchanged webview runs against an exported
 * trace exactly as it runs against a live host. A `Subscribe` is answered
 * with the one frame `traceFrame` cuts once the document has loaded; a
 * request is refused, since an exported trace is read-only; the first
 * answer also selects the run so the shell opens on its conversation rather
 * than the New-task state.
 *
 * The document loads two ways: inline (`window.__TEXRA_TRACE__`, set by the
 * CLI export so the page is one self-contained file: `fetch()` of a local
 * file fails under `file://`), or a fetched `trace.json` beside the page
 * (the default over http). Both are externally authored, so both pass the
 * same `parseTraceData` boundary.
 */
import {
  HOST_BRIDGE_API_KEY,
  type HostBridgeApi,
} from '@shared/hostBridgeTypes';
import {
  UpMessageSchema,
  type DownMessage,
} from '@shared/session/sessionFrames';
import type { TraceDocument } from '@transcript';

import { parseTraceData } from './traceDataSchema';
import { traceFrame } from './traceFrames';

/** The session key the page's `<progress-app data-session>` names. */
const TRACE_SESSION = 'trace';

async function loadTrace(): Promise<TraceDocument> {
  const globalWindow = window as { __TEXRA_TRACE__?: unknown };
  const inline = globalWindow.__TEXRA_TRACE__;
  if (inline) {
    // Once consumed, drop the raw copy: nothing else reads this global.
    delete globalWindow.__TEXRA_TRACE__;
    return parseTraceData(inline);
  }
  const params = new URLSearchParams(window.location.search);
  const file = params.get('trace') ?? 'trace.json';
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: ${res.status}`);
  return parseTraceData(await res.json());
}

function deliver(message: DownMessage): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function installTraceHostBridge(document: Promise<TraceDocument>): void {
  let state: unknown;
  let selected = false;
  const bridge: HostBridgeApi = {
    postMessage(message) {
      const parsed = UpMessageSchema.safeParse(message);
      if (!parsed.success) {
        console.warn('[trace-viewer] unrecognized shell message', message);
        return;
      }
      const up = parsed.data;
      switch (up.kind) {
        case 'subscribe':
          document.then(
            (loaded) => {
              deliver(traceFrame(loaded, TRACE_SESSION, up));
              if (selected) return;
              selected = true;
              deliver({
                kind: 'surface.action',
                session: TRACE_SESSION,
                action: { kind: 'select', streamId: loaded.streamId },
              });
            },
            // The entry renders the load failure; a subscribe with no
            // document has nothing to answer.
            () => undefined,
          );
          return;
        case 'runtime.request':
        case 'host.request':
          deliver({
            kind: 'response',
            session: TRACE_SESSION,
            requestId: up.requestId,
            result: {
              ok: false,
              error: {
                _tag: 'Rejected',
                reason: 'An exported trace is read-only.',
              },
            },
          });
          return;
      }
    },
    getState: () => state,
    setState: (next) => {
      state = next;
    },
  };
  (globalThis as { [HOST_BRIDGE_API_KEY]?: HostBridgeApi })[
    HOST_BRIDGE_API_KEY
  ] = bridge;
}

/** The document this page shows; the bridge answers subscribes from it. */
export const trace: Promise<TraceDocument> = loadTrace();
installTraceHostBridge(trace);
