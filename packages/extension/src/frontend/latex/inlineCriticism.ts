/**
 * Experimental: surface `\criticize{message}{severity}{confidence}` annotations
 * inserted by critique-style agents (criticize, notation, elevate, verifyFix,
 * ...) as VS Code diagnostics, so they show up as squiggles in the editor and
 * entries in the Problems panel — like a linter.
 *
 * Two ingest paths:
 *   1. Bus event hook: every time an agent round emits `addOutputFiles`, we
 *      read each output file and brute-force parse `\criticize{...}` macros
 *      out of it. Universal — any agent that writes the macro participates.
 *   2. Tool sink (`add_criticism` tool): tool-use agents that want to flag an
 *      issue without literally writing `\criticize{...}` into the document
 *      can call the tool, which routes through `pushManualCriticism` here.
 *
 * Gated on `texra.inlineCriticism.enabled` (default: false).
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import { parseCriticismAnnotations } from '@latex/criticismParser';
import * as logger from '@logger/logUtils';
import type { OutputFileInfo } from '@shared/schemas';
import { getConfig } from '@utils/config';

const CHANNEL = 'InlineCriticism';
const SETTING_KEY = 'inlineCriticism.enabled';
const COLLECTION_NAME = 'texra-criticism';
const SOURCE_LABEL = 'TeXRA';

/** Manual criticism entry pushed by tool-use agents via `add_criticism`. */
export interface ManualCriticismEntry {
  /** Absolute path to the file the criticism applies to. */
  absolutePath: string;
  /** 1-based line number (matches editor gutter). */
  line: number;
  message: string;
  /** 1–5; mapped to DiagnosticSeverity. */
  severity: number;
  /** 1–5; appended to the message as `(S/C)`. */
  confidence: number;
}

let collection: vscode.DiagnosticCollection | undefined;
let busUnsubscribe: (() => void) | undefined;

/** Severity 5 → Error, 4 → Warning, 3 → Info, 1–2 → Hint. */
function mapSeverity(severity: number): vscode.DiagnosticSeverity {
  if (severity >= 5) return vscode.DiagnosticSeverity.Error;
  if (severity >= 4) return vscode.DiagnosticSeverity.Warning;
  if (severity >= 3) return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Hint;
}

function isEnabled(): boolean {
  return getConfig<boolean>(SETTING_KEY, false) === true;
}

async function readFileText(absolutePath: string): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.file(absolutePath),
    );
    return Buffer.from(bytes).toString('utf8');
  } catch (error) {
    logger.error(
      CHANNEL,
      `Failed to read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function refreshFileDiagnostics(file: OutputFileInfo): Promise<void> {
  if (!collection) return;
  const absolutePath = file.location.absolutePath;
  if (!absolutePath.toLowerCase().endsWith('.tex')) return;

  const text = await readFileText(absolutePath);
  if (text === null) return;

  const annotations = parseCriticismAnnotations(text);
  const uri = vscode.Uri.file(absolutePath);

  if (annotations.length === 0) {
    collection.delete(uri);
    return;
  }

  const diagnostics = annotations.map((a) => {
    const range = new vscode.Range(
      a.line,
      a.column,
      a.line,
      a.column + a.length,
    );
    const diag = new vscode.Diagnostic(
      range,
      `${a.message} (S${a.severity}/C${a.confidence})`,
      mapSeverity(a.severity),
    );
    diag.source = SOURCE_LABEL;
    diag.code = 'criticize';
    return diag;
  });
  collection.set(uri, diagnostics);
}

function handleAddOutputFiles(payload: {
  filesByRound: { [key: number]: OutputFileInfo[] };
}): void {
  if (!collection) return;
  const allFiles = Object.values(payload.filesByRound).flat();
  void Promise.all(allFiles.map((f) => refreshFileDiagnostics(f))).catch(
    (error: unknown) => {
      logger.error(
        CHANNEL,
        `Failed to refresh criticism diagnostics: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
}

function enable(context: vscode.ExtensionContext): void {
  if (collection) return;
  collection = vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
  context.subscriptions.push(collection);
  busUnsubscribe = bus.on('addOutputFiles', handleAddOutputFiles);
  logger.info(CHANNEL, 'Inline criticism diagnostics enabled');
}

function disable(): void {
  if (busUnsubscribe) {
    busUnsubscribe();
    busUnsubscribe = undefined;
  }
  if (collection) {
    collection.clear();
    collection.dispose();
    collection = undefined;
  }
  logger.info(CHANNEL, 'Inline criticism diagnostics disabled');
}

/**
 * Push a single criticism entry from a tool-use agent. Returns false if the
 * feature is disabled (no diagnostic collection is registered). Appends to
 * (rather than replacing) the file's diagnostics so a tool can add multiple
 * entries across multiple calls.
 */
export function pushManualCriticism(entry: ManualCriticismEntry): boolean {
  if (!collection) return false;

  const uri = vscode.Uri.file(entry.absolutePath);
  const lineIndex = Math.max(0, Math.floor(entry.line) - 1);
  const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);
  const diag = new vscode.Diagnostic(
    range,
    `${entry.message} (S${entry.severity}/C${entry.confidence})`,
    mapSeverity(entry.severity),
  );
  diag.source = SOURCE_LABEL;
  diag.code = 'criticize:tool';

  const existing = collection.get(uri) ?? [];
  collection.set(uri, [...existing, diag]);
  return true;
}

/**
 * Register the inline-criticism subsystem. Honors the setting at activation
 * and re-evaluates on configuration changes.
 */
export function registerInlineCriticism(context: vscode.ExtensionContext): void {
  if (isEnabled()) enable(context);

  const watcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(`texra.${SETTING_KEY}`)) return;
    if (isEnabled()) enable(context);
    else disable();
  });
  context.subscriptions.push(watcher);
  context.subscriptions.push({ dispose: disable });
}
