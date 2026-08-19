/**
 * Experimental: surface `\criticize{message}{severity}{confidence}` annotations
 * inserted by critique-style agents (criticize, notation, elevate, verifyFix,
 * ...) as VS Code diagnostics — squiggles in the editor and entries in the
 * Problems panel, like a linter.
 *
 * Two ingest paths:
 *   1. Session run facts keyed by `addOutputFiles` parse each output
 *      `.tex` file. Universal — any agent that writes the macro participates.
 *   2. The `diagnostics` tool's `add` command routes through
 *      `pushManualCriticism` here for tool-use agents that want to flag issues
 *      without inserting the macro.
 *
 * Gated on the `INLINE_CRITICISM_ENABLED` global state key, surfaced as a
 * toggle in the LaTeX settings tab (default: false).
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  defaultSession,
  type ManualCriticismEntry,
  type SessionEventHub,
} from '@agent/runtime';
import { subscribeAddOutputFilesRunFact } from '@frontend/events/runFactSubscriptions';
import { lineToRange } from '@frontend/vscode/vscodeEditor';
import { parseCriticismAnnotations } from '@latex/criticismParser';
import { createLog } from '@logger/logUtils';
import { tryGlobalState } from '@platform/platform';
import type { AddOutputFilesPayload, OutputFileInfo } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { hasExtension } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('InlineCriticism');
const COLLECTION_NAME = 'texra-criticism';
const SOURCE_LABEL = 'TeXRA';
const CODE_PARSED = 'criticize';
const CODE_TOOL = 'criticize:tool';

let collection: vscode.DiagnosticCollection | undefined;
let runFactUnsubscribe: (() => void) | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let sessionEvents: SessionEventHub | undefined;

/** Criticism severity (0–5) → VS Code DiagnosticSeverity. */
function mapSeverity(severity: number): vscode.DiagnosticSeverity {
  if (severity >= 5) return vscode.DiagnosticSeverity.Error;
  if (severity >= 4) return vscode.DiagnosticSeverity.Warning;
  if (severity >= 3) return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Hint;
}

export function isInlineCriticismEnabled(): boolean {
  return (
    tryGlobalState()?.get<boolean>(
      GlobalStateKey.INLINE_CRITICISM_ENABLED,
      false,
    ) === true
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

async function refreshFileDiagnostics(file: OutputFileInfo): Promise<void> {
  const activeCollection = collection;
  if (!activeCollection) return;
  const absolutePath = file.location.absolutePath;
  if (!hasExtension(absolutePath, '.tex')) return;

  let text: string;
  try {
    text = await AbsoluteFS.read(absolutePath);
  } catch (error) {
    log.error(`Failed to read ${absolutePath}: ${toErrorMessage(error)}`);
    return;
  }

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
}

function handleAddOutputFiles(payload: AddOutputFilesPayload): void {
  if (!collection) return;
  const allFiles = Object.values(payload.filesByRound).flat();
  void Promise.all(allFiles.map((f) => refreshFileDiagnostics(f))).catch(
    (error: unknown) => {
      log.error(
        `Failed to refresh criticism diagnostics: ${toErrorMessage(error)}`,
      );
    },
  );
}

function enable(context: vscode.ExtensionContext): void {
  if (collection) return;
  collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  context.subscriptions.push(collection);
  runFactUnsubscribe = subscribeAddOutputFilesRunFact(
    sessionEvents ?? defaultSession().events,
    handleAddOutputFiles,
  );
  log.info('Inline criticism diagnostics enabled');
}

function disable(): void {
  if (runFactUnsubscribe) {
    runFactUnsubscribe();
    runFactUnsubscribe = undefined;
  }
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
  events: SessionEventHub = defaultSession().events,
): void {
  extensionContext = context;
  sessionEvents = events;
  if (isInlineCriticismEnabled()) enable(context);
  context.subscriptions.push({ dispose: disable });
}

/**
 * Persist the new setting value and reconcile the active subsystem. Called
 * from the settings webview handler when the user toggles the checkbox.
 */
export async function setInlineCriticismEnabled(
  enabled: boolean,
): Promise<void> {
  await tryGlobalState()?.update(
    GlobalStateKey.INLINE_CRITICISM_ENABLED,
    enabled,
  );
  if (!extensionContext) {
    throw new Error(
      'setInlineCriticismEnabled called before registerInlineCriticism',
    );
  }
  if (enabled) enable(extensionContext);
  else disable();
}
