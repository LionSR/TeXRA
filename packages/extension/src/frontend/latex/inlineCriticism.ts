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
 * Gated on the `INLINE_CRITICISM_ENABLED` global state key, surfaced as a
 * toggle in the LaTeX settings tab (default: false).
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
import { createLog } from '@logger/logUtils';
import type { StateStore, StateReadFailed } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { AddOutputFilesPayload, OutputFileInfo } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { hasExtension } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'InlineCriticism';
const log = createLog(CHANNEL);
const COLLECTION_NAME = 'texra-criticism';
const SOURCE_LABEL = 'TeXRA';
const CODE_PARSED = 'criticize';
const CODE_TOOL = 'criticize:tool';

/** What {@link registerInlineCriticism} attached the feature to. */
interface CriticismRegistration {
  readonly context: vscode.ExtensionContext;
  readonly session: Pick<SessionHandle, 'events' | 'now'>;
  readonly runtime: ProcessRuntime;
  readonly globalState: StateStore;
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

/** Read the shared state store; before registration the feature is off. */
export function isInlineCriticismEnabled(): Effect.Effect<
  boolean,
  StateReadFailed
> {
  return Effect.suspend(() =>
    registration
      ? registration.globalState
          .get<boolean>(GlobalStateKey.INLINE_CRITICISM_ENABLED, false)
          .pipe(Effect.map((enabled) => enabled === true))
      : Effect.succeed(false),
  );
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

const logEnabled = Effect.logInfo('Inline criticism diagnostics enabled').pipe(
  withLogChannel(CHANNEL),
);

function disable(): void {
  outputUnsubscribe?.();
  outputUnsubscribe = undefined;
  if (collection) {
    collection.clear();
    collection.dispose();
    collection = undefined;
  }
  log.info('Inline criticism diagnostics disabled');
}

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
  globalState: StateStore,
): Effect.Effect<void, StateReadFailed> {
  return Effect.gen(function* () {
    const enabled = yield* globalState.get<boolean>(
      GlobalStateKey.INLINE_CRITICISM_ENABLED,
      false,
    );
    registration = { context, session, runtime, globalState };
    if (enabled === true && enable(registration)) yield* logEnabled;
    context.subscriptions.push({ dispose: disable });
  });
}

/** Persist the setting before reconciling the active diagnostics. */
export function setInlineCriticismEnabled(
  enabled: boolean,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const current = registration;
    if (!current) {
      return yield* Effect.fail(
        new Error(
          'setInlineCriticismEnabled called before registerInlineCriticism',
        ),
      );
    }
    yield* current.globalState.update(
      GlobalStateKey.INLINE_CRITICISM_ENABLED,
      enabled,
    );
    if (enabled) {
      if (enable(current)) yield* logEnabled;
    } else disable();
  });
}
