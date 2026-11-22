/**
 * The host editor's capabilities TeXRA's tools use: a file's diagnostics, an
 * inline criticism, and a PDF in the host's viewer, read by a session's
 * storage root. A composition's reading is its window table's
 * (`makeWindowTable`): what the project's attached windows offer, routed to
 * the one focused last. The same reading serves the harness's
 * `HostCapabilities`, one capability per offered member, so a tool that
 * declares a member is offered exactly while a window offers it: one owner
 * for the capability and its code.
 */
import { Context, type Effect, Schema } from 'effect';

import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';
import type { FileLocation } from '@texra-ai/worldline/schemas';

/**
 * Why the host could not read a file's diagnostics: the LaTeX build the read
 * triggers faulted (`build-failed`), the host's diagnostics collection threw
 * (`read-failed`), or, for a service window, it closed before answering
 * (`detached`) or did not answer in time (`no-answer`).
 */
export class DiagnosticsReadFailed extends Schema.TaggedError<DiagnosticsReadFailed>()(
  'DiagnosticsReadFailed',
  {
    reason: Schema.Literals([
      'build-failed',
      'read-failed',
      'detached',
      'no-answer',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** The host's viewer refused a PDF the tool had already located on disk. */
export class PdfOpenFailed extends Schema.TaggedError<PdfOpenFailed>()(
  'PdfOpenFailed',
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** One critique the diagnostics tool adds as an editor diagnostic. */
export const ManualCriticismEntrySchema = Schema.Struct({
  /** Absolute path resolved by the diagnostics tool. */
  absolutePath: Schema.String,
  /** 1-based line number. */
  line: Schema.Int,
  message: Schema.String,
  /** 0-5; mapped to DiagnosticSeverity by the host. */
  severity: Schema.Int,
  /** 1-5; appended to the message as `(S/C)`. */
  confidence: Schema.Int,
});
export type ManualCriticismEntry = typeof ManualCriticismEntrySchema.Type;

/** What a host's editor offers one session; a member left out is not offered. */
export interface EditorCapabilities {
  /** A file's diagnostics from the editor's own tooling (`path` absolute). */
  readonly readDiagnostics?: (
    path: string,
  ) => Effect.Effect<readonly GenericDiagnostic[], DiagnosticsReadFailed>;
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

/** The host capabilities an editor serves (`HostCapabilities`): its
 *  attached members, so a tool's `hostCapability` that names none fails to
 *  compile. */
export type EditorCapability = keyof EditorCapabilities;

/** What the editor tools read: the capabilities offered for a session's
 *  storage root ({} for none). */
interface EditorHostShape {
  readonly at: (storage: string) => EditorCapabilities;
}

/** The composition's editor reading, served to the editor tools through
 *  their plugins' process layers. */
export class EditorHost extends Context.Service<EditorHost, EditorHostShape>()(
  '@texra-ai/texra/tools/EditorHost',
) {}

/** An editor reading that is also the harness's `HostCapabilities`: the
 *  members it offers a storage root, by name. */
export interface EditorRegistry extends EditorHostShape {
  readonly of: (storage: string) => ReadonlySet<string>;
}

/** The registry over `at`, whose offered members are its capabilities. */
export const editorRegistry = (
  at: (storage: string) => EditorCapabilities,
): EditorRegistry => ({
  at,
  of: (storage) =>
    new Set(
      Object.entries(at(storage)).flatMap(([member, value]) =>
        value === undefined ? [] : [member],
      ),
    ),
});
