/**
 * Embeds a {@link TraceDocument} directly into the trace-viewer's
 * single-file bundle (`packages/trace-viewer`'s `vite.config.ts` build) so
 * the exported page needs no `fetch()`
 * of a sidecar `trace.json` — `fetch()` of a local file fails entirely under
 * `file://`, same as an external `<script src>` (see that config's header
 * comment). `main.ts`'s `loadTrace()` reads this global if present, before
 * falling back to fetching `trace.json`.
 */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Schema, type PlatformError } from 'effect';

// Local imports
import { absentReason } from '@texra-ai/harness/node';
import type { Session } from '@texra-ai/harness';
import type { AssembleTraceResult } from '@texra-ai/harness/host';
import type { RunId, TraceDocument } from '@texra-ai/harness/schemas';

/** The run has no trace to show: no saved configuration, or no replayable
 *  run-root transcript. Each host words the status its own way. */
export class TraceUnavailable extends Schema.TaggedError<TraceUnavailable>()(
  'TraceUnavailable',
  { status: Schema.Literals(['config_missing', 'streamLogs_missing']) },
) {}

/** The host's install has no trace-viewer bundle at `path` (a checkout where
 *  `packages/trace-viewer` was not built); each host names its rebuild. */
export class TraceViewerMissing extends Schema.TaggedError<TraceViewerMissing>()(
  'TraceViewerMissing',
  { path: Schema.String },
) {}

const MODULE_SCRIPT_MARKER = '<script type="module"';

/**
 * `<` must not appear literally inside the injected `<script>` body — the
 * HTML parser tokenizes `</script` as the tag's end regardless of it being
 * inside a JS string, so a trace entry containing that literal substring
 * (e.g. a message quoting HTML) would truncate the script and could inject
 * unrelated markup. `<` is a plain Unicode escape inside the JS string
 * literal — semantically identical to `<` once parsed — so this only
 * affects HTML tokenization, not the embedded data.
 */
function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

export function injectStandaloneTrace(
  template: string,
  trace: TraceDocument,
): string {
  const index = template.indexOf(MODULE_SCRIPT_MARKER);
  if (index === -1) {
    throw new Error(
      'Trace-viewer standalone template is missing its module <script> tag — ' +
        'rebuild packages/trace-viewer (its output format may have changed).',
    );
  }
  const inlineScript = `<script>window.__TEXRA_TRACE__ = ${jsonForInlineScript(trace)};</script>\n    `;
  return template.slice(0, index) + inlineScript + template.slice(index);
}

/**
 * A run as one self-contained page: its trace embedded into the trace
 * viewer's single-file bundle under the host's `resourcesPath`. The trace and
 * its run record come back beside the page for a host that names the file
 * after them.
 */
export const traceHtml = Effect.fn('traceHtml')(function* (
  session: Session,
  runId: RunId,
  resourcesPath: string,
): Effect.fn.Return<
  Omit<Extract<AssembleTraceResult, { status: 'ok' }>, 'status'> & {
    readonly html: string;
  },
  // Listed apart: inferred, the tagged errors would merge into `Error`.
  TraceUnavailable | TraceViewerMissing | PlatformError.PlatformError | Error,
  FileSystem.FileSystem
> {
  const result = yield* session.records(runId).readTrace();
  if (result.status !== 'ok')
    return yield* new TraceUnavailable({ status: result.status });
  const templatePath = path.join(resourcesPath, 'traceViewer', 'index.html');
  const fs = yield* FileSystem.FileSystem;
  const template = yield* fs
    .readFileString(templatePath)
    .pipe(
      Effect.catchIf(absentReason, () =>
        Effect.fail(new TraceViewerMissing({ path: templatePath })),
      ),
    );
  return {
    html: injectStandaloneTrace(template, result.trace),
    trace: result.trace,
    record: result.record,
  };
});
