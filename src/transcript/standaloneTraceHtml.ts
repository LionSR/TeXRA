/**
 * Embeds a {@link TraceDocument} directly into the trace-viewer's
 * single-file standalone bundle (`packages/trace-viewer`'s
 * `vite.standalone.config.ts` build) so the exported page needs no `fetch()`
 * of a sidecar `trace.json` — `fetch()` of a local file fails entirely under
 * `file://`, same as an external `<script src>` (see that config's header
 * comment). `main.ts`'s `loadTrace()` reads this global if present, before
 * falling back to fetching `trace.json`.
 */
import type { TraceDocument } from './traceDocumentSchema';

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
