/**
 * The host editor's capabilities TeXRA's tools use: a file's diagnostics, an
 * inline criticism, and a PDF in the host's viewer. One registry per
 * composition, keyed by a session's storage root: a host attaches what it
 * offers for a session for its scope (the VS Code window for its own
 * session; the service, routing to that project's windows), and the newest
 * attachment answers. The same registry serves the harness's
 * `HostCapabilities`, so the `diagnostics` tool is offered exactly while an
 * implementation is attached: one owner for the capability and its code.
 */
import { Context, Data, Effect, type Scope } from 'effect';

import type { FileLocation } from '@shared/schemas';
import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';

/**
 * Why the host could not read a file's diagnostics: the LaTeX build the read
 * triggers faulted (`build-failed`), the host's diagnostics collection threw
 * (`read-failed`), or, for a service window, it closed before answering
 * (`detached`) or did not answer in time (`no-answer`).
 */
export class DiagnosticsReadFailed extends Data.TaggedError(
  'DiagnosticsReadFailed',
)<{
  readonly reason: 'build-failed' | 'read-failed' | 'detached' | 'no-answer';
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The host's viewer refused a PDF the tool had already located on disk. */
export class PdfOpenFailed extends Data.TaggedError('PdfOpenFailed')<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** One critique the diagnostics tool adds as an editor diagnostic. */
export interface ManualCriticismEntry {
  /** Absolute path resolved by the diagnostics tool. */
  readonly absolutePath: string;
  /** 1-based line number. */
  readonly line: number;
  readonly message: string;
  /** 0-5; mapped to DiagnosticSeverity by the host. */
  readonly severity: number;
  /** 1-5; appended to the message as `(S/C)`. */
  readonly confidence: number;
}

/** What a host's editor offers one session; a member left out is not offered. */
export interface EditorCapabilities {
  /** A file's diagnostics from the editor's own tooling (`path` absolute). */
  readonly readDiagnostics?: (
    path: string,
  ) => Effect.Effect<GenericDiagnostic[], DiagnosticsReadFailed>;
  /** Add one critique; false where inline criticism is off. */
  readonly addCriticism?: (
    entry: ManualCriticismEntry,
  ) => Effect.Effect<boolean, Error>;
  /** Show a PDF in the host's viewer. */
  readonly openPdf?: (request: {
    readonly location: FileLocation;
    readonly preserveFocus: boolean;
  }) => Effect.Effect<void, PdfOpenFailed>;
}

/** The host capabilities an editor serves (`HostCapabilities`), named
 *  here so a tool's `hostCapability` that names none fails to compile. */
export type EditorCapability = 'diagnostics';

/** The registry's interface: attach for a scope, read by storage root. */
export interface EditorHostShape {
  readonly attach: (
    storage: string,
    capabilities: EditorCapabilities,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** What the newest attachment for `storage` offers ({} for none). */
  readonly at: (storage: string) => EditorCapabilities;
}

/** The composition's editor registry, served to the editor tools through
 *  their plugins' process layers. */
export class EditorHost extends Context.Service<EditorHost, EditorHostShape>()(
  '@texra/tools/EditorHost',
) {}

/** A composition's editor registry (`makeEditorHost`). */
export type EditorRegistry = ReturnType<typeof makeEditorHost>;

/** A registry with nothing attached: what a composition passes its plugins
 *  and attaches its hosts to. Also the harness's `HostCapabilities` over the
 *  same attachments. */
export function makeEditorHost(): EditorHostShape & {
  readonly of: (storage: string) => ReadonlySet<EditorCapability>;
} {
  const attached = new Map<string, EditorCapabilities[]>();
  const at = (storage: string): EditorCapabilities =>
    attached.get(storage)?.at(-1) ?? {};
  return {
    attach: (storage, capabilities) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          attached.set(storage, [
            ...(attached.get(storage) ?? []),
            capabilities,
          ]),
        ),
        () =>
          Effect.sync(() => {
            const rest = (attached.get(storage) ?? []).filter(
              (entry) => entry !== capabilities,
            );
            if (rest.length === 0) attached.delete(storage);
            else attached.set(storage, rest);
          }),
      ).pipe(Effect.asVoid),
    at,
    of: (storage) =>
      new Set<EditorCapability>(
        at(storage).readDiagnostics ? ['diagnostics'] : [],
      ),
  };
}
