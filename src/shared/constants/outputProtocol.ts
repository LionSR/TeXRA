/**
 * Unified output protocol tag names
 * (`docs/proposals/unified-output-protocol.md`).
 *
 * Every bundled and custom agent converged on one output container —
 * `<documents><document name="...">...</document></documents>` — so these
 * are fixed protocol constants, not per-agent configuration. They used to be
 * threaded through as `settings.documentTag` / `settings.endTag`; that
 * configurability is gone (see `AgentDataclass.ts`'s legacy-field strip), and
 * every consumer reads these constants directly instead.
 */

/** Outer container tag wrapping every document the model emits. */
export const OUTPUT_DOCUMENTS_TAG = 'documents';

/** Per-document child tag inside the container, carrying a `name` attribute. */
export const OUTPUT_DOCUMENT_TAG = 'document';

/** Closing tag that marks a complete response. */
export const OUTPUT_END_TAG = `</${OUTPUT_DOCUMENTS_TAG}>`;
