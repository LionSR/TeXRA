/**
 * Experimental: surface `\criticize{message}{severity}{confidence}` annotations
 * inserted by critique-style agents (criticize, notation, elevate, verifyFix,
 * ...) as VS Code diagnostics — squiggles in the editor and entries in the
 * Problems panel, like a linter.
 *
 * Two ingest paths:
 *   1. Session `output.produced` rows parse each output
 *      `.tex` file. Universal — any agent that writes the macro participates.
 *   2. The `diagnostics` tool's `add` command routes through
 *      `pushManualCriticism` here for tool-use agents that want to flag issues
 *      without inserting the macro.
 *
 * Gated on the `texra.inlineCriticism.enabled` catalog row (global state,
 * default false), a switch on the LaTeX settings page. The settings write goes
 * through the generic catalog path; {@link syncInlineCriticism} then reconciles
 * the diagnostics with the stored value.
 */

// Third-party imports
import { Cause, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { type ManualCriticismEntry, type SessionHandle } from '@agent/runtime';
import { subscribeOutputFiles } from '@frontend/events/runFactSubscriptions';
import { lineToRange } from '@frontend/vscode/vscodeEditor';
import { parseCriticismAnnotations } from '@latex/criticismParser';
import { withLogChannel } from '@logger/effectLog';
import type { StateReadFailed } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { AddOutputFilesPayload, OutputFileInfo } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';
import { hasExtension } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'InlineCriticism';
const COLLECTION_NAME = 'texra-criticism';
const SOURCE_LABEL = 'TeXRA';
const CODE_PARSED = 'criticize';
const CODE_TOOL = 'criticize:tool';

/** What {@link registerInlineCriticism} attached the feature to. */
interface CriticismRegistration {
  readonly context: vscode.ExtensionContext;
  readonly session: Pick<SessionHandle, 'events' | 'now'>;
  readonly runtime: ProcessRuntime;
  readonly stores: SettingsStores;
}

let collection: vscode.DiagnosticCollection | undefined;
let outputUnsubscribe: (() => void) | undefined;
/** The single owner of the context and event hub `enable` works against. */
let registration: CriticismRegistration | undefined;

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

const refreshFileDiagnostics = Effect.fnUntraced(function* (
  file: OutputFileInfo,
) {
  const activeCollection = collection;
  if (!activeCollection) return;
  const absolutePath = file.location.absolutePath;
  if (!hasExtension(absolutePath, '.tex')) return;

  const fs = yield* FileSystem.FileSystem;
  // An unreadable output file loses its squiggles, not the whole refresh.
  const text = yield* fs.readFileString(absolutePath).pipe(
    Effect.map(normalizeLineEndings),
    Effect.catch((error) =>
      Effect.logError(`Failed to read ${absolutePath}: ${error.message}`).pipe(
        withLogChannel(CHANNEL),
        Effect.as(undefined),
      ),
    ),
  );
  if (text === undefined) return;

  if (collection !== activeCollection) return;

  const annotations = parseCriticismAnnotations(text);
  const uri = vscode.Uri.file(absolutePath);
  const manualDiagnostics = (activeCollection.get(uri) ?? []).filter(
    (diag) => diag.code === CODE_TOOL,
  );

  if (annotations.length === 0) {
    if (manualDiagnostics.length > 0) {
      activeCollection.set(uri, manualDiagnostics);
    } else {
      activeCollection.delete(uri);
    }
    return;
  }

  activeCollection.set(uri, [
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
  ]);
});

function handleAddOutputFiles(
  payload: AddOutputFilesPayload,
  runtime: ProcessRuntime,
): void {
  if (!collection) return;
  const allFiles = Object.values(payload.filesByRound).flat();
  runtime.runFork(
    Effect.forEach(allFiles, refreshFileDiagnostics, {
      concurrency: 'unbounded',
      discard: true,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          `Failed to refresh criticism diagnostics: ${toErrorMessage(Cause.squash(cause))}`,
        ).pipe(withLogChannel(CHANNEL)),
      ),
    ),
  );
}

/** Answers whether this call enabled the diagnostics (false when already on). */
function enable({ context, session, runtime }: CriticismRegistration): boolean {
  if (collection) return false;
  collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  context.subscriptions.push(collection);
  outputUnsubscribe = subscribeOutputFiles(
    session,
    (payload) => handleAddOutputFiles(payload, runtime),
    runtime,
  );
  return true;
}

/** Answers whether this call disabled the diagnostics (false when already off). */
function disable(): boolean {
  outputUnsubscribe?.();
  outputUnsubscribe = undefined;
  if (!collection) return false;
  collection.clear();
  collection.dispose();
  collection = undefined;
  return true;
}

/** Turn the diagnostics on or off to match the stored setting. */
const reconcile = Effect.fnUntraced(function* (current: CriticismRegistration) {
  const enabled = yield* readSettingFrom<boolean>(
    current.stores,
    GlobalStateKey.INLINE_CRITICISM_ENABLED,
  );
  if (enabled ? enable(current) : disable()) {
    yield* Effect.logInfo(
      `Inline criticism diagnostics ${enabled ? 'enabled' : 'disabled'}`,
    ).pipe(withLogChannel(CHANNEL));
  }
});

/**
 * Append a criticism entry from a tool-use agent. Returns false when the
 * feature is disabled so the tool can report the no-op back to the agent.
 */
export function pushManualCriticism(entry: ManualCriticismEntry): boolean {
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
}

export function registerInlineCriticism(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  session: Pick<SessionHandle, 'events' | 'now'>,
  stores: SettingsStores,
): Effect.Effect<void, StateReadFailed> {
  return Effect.suspend(() => {
    registration = { context, session, runtime, stores };
    context.subscriptions.push({ dispose: disable });
    return reconcile(registration);
  });
}

/**
 * Reconcile the diagnostics after a write to the setting. The settings view
 * calls this once the catalog write has landed.
 */
export function syncInlineCriticism(): Effect.Effect<
  void,
  StateReadFailed | Error
> {
  return Effect.suspend(() =>
    registration
      ? reconcile(registration)
      : Effect.fail(
          new Error(
            'syncInlineCriticism called before registerInlineCriticism',
          ),
        ),
  );
}
