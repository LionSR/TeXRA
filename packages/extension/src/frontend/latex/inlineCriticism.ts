/**
 * Experimental: surface `\criticize{message}{severity}{confidence}` annotations
 * inserted by critique-style agents (criticize, notation, logic, enhance,
 * ...) as VS Code diagnostics — squiggles in the editor and entries in the
 * Problems panel, like a linter.
 *
 * Two ingest paths:
 *   1. A document task's documents rows parse each output `.tex` file.
 *      Universal — any agent that writes the macro participates.
 *   2. The `diagnostics` tool's `add` command routes through the `add` of
 *      {@link makeInlineCriticism} here, for agents that want to flag issues
 *      without inserting the macro.
 *
 * Gated on the `texra.inlineCriticism.enabled` catalog row (global state,
 * default false), a switch on the LaTeX settings page. The settings write goes
 * through the generic catalog path; its `follow` follows the
 * stored value, here or written by another window.
 */

// Third-party imports
import { Effect, FileSystem, Predicate, Stream } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  AppState,
  type PerKeyLane,
  withPerKeyLane,
} from '@texra-ai/harness/host';
import { readNormalizedFile } from '@texra-ai/harness/node';
import { toErrorMessage, hasExtension } from '@texra-ai/harness/schemas';
import { outputFilesProduced } from '@texra/controllers/session/outputFilesProduced';
import { lineToRange } from '@frontend/vscode/vscodeEditor';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import type { ManualCriticismEntry } from '@texra/tools/editorHost';
import { parseCriticismAnnotations } from '@latex/criticismParser';
import type { Session } from '@texra-ai/harness';
import {
  withLogChannel,
  Settings,
  type SettingsStores,
} from '@texra-ai/harness/plugins';
import { INLINE_CRITICISM_SETTING } from '@texra/shared/settings/texraSettings';

const CHANNEL = 'InlineCriticism';
const COLLECTION_NAME = 'texra-criticism';
const SOURCE_LABEL = 'TeXRA';
const CODE_PARSED = 'criticize';
const CODE_TOOL = 'criticize:tool';

/** Criticism severity (0–5) → VS Code DiagnosticSeverity. */
function mapSeverity(severity: number): vscode.DiagnosticSeverity {
  if (severity >= 5) return vscode.DiagnosticSeverity.Error;
  if (severity >= 4) return vscode.DiagnosticSeverity.Warning;
  if (severity >= 3) return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Hint;
}

function buildDiagnostic(
  range: vscode.Range,
  message: string,
  severity: number,
  confidence: number,
  code: string,
): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(
    range,
    `${message} (S${severity}/C${confidence})`,
    mapSeverity(severity),
  );
  diag.source = SOURCE_LABEL;
  diag.code = code;
  return diag;
}

/** The editor's criticism diagnostics: their follower and the tool's
 *  entries, over one collection that is open while the setting is on. */
interface InlineCriticism {
  /**
   * Show the diagnostics while the setting is on, following every write to
   * it. Runs until interrupted; the activation scope holds it, so
   * deactivation closes the collection. A setting that cannot be read is
   * logged, and the diagnostics stay as they were.
   */
  readonly follow: (
    session: Pick<Session, 'view'>,
    stores: SettingsStores,
  ) => Effect.Effect<void, never, AppState | FileSystem.FileSystem>;
  /** Append a criticism entry from an agent. Answers false when the
   *  feature is off, so the tool can report the no-op back to the agent. */
  readonly add: (entry: ManualCriticismEntry) => boolean;
}

/** Inline criticism for one activation: the collection {@link follow} opens
 *  is the one {@link add} writes into, and nothing outlives the instance. */
export function makeInlineCriticism(): InlineCriticism {
  /** The diagnostics while the setting is on. */
  let collection: vscode.DiagnosticCollection | undefined;
  const fileLanes = new Map<string, PerKeyLane>();

  const refreshFileDiagnostics = Effect.fnUntraced(function* (
    file: OutputFileInfo,
  ) {
    const activeCollection = collection;
    if (!activeCollection) return;
    const absolutePath = file.location.absolutePath;
    if (!hasExtension(absolutePath, '.tex')) return;

    const fs = yield* FileSystem.FileSystem;
    // An unreadable output file loses its squiggles, not the whole refresh.
    const text = yield* readNormalizedFile(fs, absolutePath).pipe(
      Effect.catch((error) =>
        Effect.logError(
          `Failed to read ${absolutePath}: ${error.message}`,
        ).pipe(withLogChannel(CHANNEL), Effect.as(undefined)),
      ),
    );
    if (text === undefined) return;

    if (collection !== activeCollection) return;

    const annotations = parseCriticismAnnotations(text);
    const uri = vscode.Uri.file(absolutePath);
    const manualDiagnostics = (activeCollection.get(uri) ?? []).filter(
      (diag) => diag.code === CODE_TOOL,
    );

    const diagnostics = [
      ...manualDiagnostics,
      ...annotations.map((a) =>
        buildDiagnostic(
          new vscode.Range(a.line, a.column, a.line, a.column + a.length),
          a.message,
          a.severity,
          a.confidence,
          CODE_PARSED,
        ),
      ),
    ];
    if (diagnostics.length > 0) activeCollection.set(uri, diagnostics);
    else activeCollection.delete(uri);
  });

  /**
   * The diagnostics, from the moment this runs until it is interrupted: the
   * collection opens, every output file a run produces refreshes its entries,
   * and an interrupt clears and closes the collection, ending the refreshes
   * it started.
   */
  const showDiagnostics = (
    session: Pick<Session, 'view'>,
  ): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        collection =
          vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
        return collection;
      }).pipe(
        Effect.tap(Effect.logInfo('Inline criticism diagnostics enabled')),
      ),
      (opened) =>
        Effect.sync(() => {
          if (collection === opened) collection = undefined;
          opened.clear();
          opened.dispose();
        }).pipe(
          Effect.andThen(
            Effect.logInfo('Inline criticism diagnostics disabled'),
          ),
        ),
    ).pipe(
      Effect.andThen(
        Stream.runForEach(outputFilesProduced(session), (files) =>
          Effect.forEach(
            files,
            // One refresh per path at a time, in arrival order: two rounds
            // writing the same output file fork two reads, and without the
            // lane the older read can land last and set stale squiggles over
            // the newer ones.
            (file) =>
              refreshFileDiagnostics(file).pipe(
                withPerKeyLane(fileLanes, file.location.absolutePath),
              ),
            { concurrency: 8, discard: true },
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                `Failed to refresh criticism diagnostics: ${toErrorMessage(cause)}`,
              ),
            ),
            Effect.forkChild,
          ),
        ),
      ),
      Effect.scoped,
    );

  const follow = (
    session: Pick<Session, 'view'>,
    stores: SettingsStores,
  ): Effect.Effect<void, never, AppState | FileSystem.FileSystem> => {
    const enabled = Settings.get(stores, INLINE_CRITICISM_SETTING).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not read whether inline criticism is on: ${error.message}`,
        ).pipe(Effect.as(undefined)),
      ),
    );
    return Stream.unwrap(
      Effect.map(AppState, (appState) =>
        appState.changes([INLINE_CRITICISM_SETTING.key]),
      ),
    ).pipe(
      Stream.mapEffect(() => enabled),
      Stream.filter(Predicate.isNotUndefined),
      Stream.changes,
      Stream.switchMap((on) =>
        on ? Stream.fromEffect(showDiagnostics(session)) : Stream.empty,
      ),
      Stream.runDrain,
      withLogChannel(CHANNEL),
    );
  };

  const add = (entry: ManualCriticismEntry): boolean => {
    if (!collection) return false;

    const uri = vscode.Uri.file(entry.absolutePath);
    const range = lineToRange(entry.line);
    const diag = buildDiagnostic(
      range,
      entry.message,
      entry.severity,
      entry.confidence,
      CODE_TOOL,
    );

    const existing = collection.get(uri) ?? [];
    // This list is only ever cleared by the whole-feature enable/disable
    // toggle, so a critique agent re-flagging the same line/message across
    // repeated rounds would otherwise stack an unbounded number of identical
    // squiggles. Skip re-adding an exact duplicate instead.
    const isDuplicate = existing.some(
      (d) =>
        d.code === CODE_TOOL &&
        d.range.start.line === range.start.line &&
        d.message === diag.message,
    );
    if (isDuplicate) return true;

    collection.set(uri, [...existing, diag]);
    return true;
  };

  return { follow, add };
}
