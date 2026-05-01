/**
 * Experimental: surface `\criticize{message}{severity}{confidence}` annotations
 * inserted by critique-style agents (criticize, notation, elevate, verifyFix,
 * ...) as VS Code diagnostics — squiggles in the editor and entries in the
 * Problems panel, like a linter.
 *
 * Two ingest paths:
 *   1. Bus event hook on `addOutputFiles` parses each output `.tex` file.
 *      Universal — any agent that writes the macro participates.
 *   2. `add_criticism` tool routes through `pushManualCriticism` here for
 *      tool-use agents that want to flag issues without inserting the macro.
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
import type { ManualCriticismEntry } from '@tools/AddCriticismTool';
import { getConfig, watchConfig } from '@utils/config';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'InlineCriticism';
const SETTING_KEY = 'inlineCriticism.enabled';
const COLLECTION_NAME = 'texra-criticism';
const SOURCE_LABEL = 'TeXRA';
const CODE_PARSED = 'criticize';
const CODE_TOOL = 'criticize:tool';

let collection: vscode.DiagnosticCollection | undefined;
let busUnsubscribe: (() => void) | undefined;

/** Criticism severity (1–5) → VS Code DiagnosticSeverity. */
function mapSeverity(severity: number): vscode.DiagnosticSeverity {
  if (severity >= 5) return vscode.DiagnosticSeverity.Error;
  if (severity >= 4) return vscode.DiagnosticSeverity.Warning;
  if (severity >= 3) return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Hint;
}

function isEnabled(): boolean {
  return getConfig<boolean>(SETTING_KEY, false) === true;
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
  if (!collection) return;
  const absolutePath = file.location.absolutePath;
  if (!absolutePath.toLowerCase().endsWith('.tex')) return;

  let text: string;
  try {
    text = await AbsoluteFS.read(absolutePath);
  } catch (error) {
    logger.error(
      CHANNEL,
      `Failed to read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const annotations = parseCriticismAnnotations(text);
  const uri = vscode.Uri.file(absolutePath);

  if (annotations.length === 0) {
    collection.delete(uri);
    return;
  }

  collection.set(
    uri,
    annotations.map((a) =>
      buildDiagnostic(
        new vscode.Range(a.line, a.column, a.line, a.column + a.length),
        a.message,
        a.severity,
        a.confidence,
        CODE_PARSED,
      ),
    ),
  );
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
 * Append a criticism entry from a tool-use agent. Returns false when the
 * feature is disabled so the tool can report the no-op back to the agent.
 */
export function pushManualCriticism(entry: ManualCriticismEntry): boolean {
  if (!collection) return false;

  const uri = vscode.Uri.file(entry.absolutePath);
  const lineIndex = Math.max(0, Math.floor(entry.line) - 1);
  const range = new vscode.Range(
    lineIndex,
    0,
    lineIndex,
    Number.MAX_SAFE_INTEGER,
  );
  const diag = buildDiagnostic(
    range,
    entry.message,
    entry.severity,
    entry.confidence,
    CODE_TOOL,
  );

  const existing = collection.get(uri) ?? [];
  collection.set(uri, [...existing, diag]);
  return true;
}

export function registerInlineCriticism(
  context: vscode.ExtensionContext,
): void {
  if (isEnabled()) enable(context);

  watchConfig(context, `texra.${SETTING_KEY}`, () => {
    if (isEnabled()) enable(context);
    else disable();
  });
  context.subscriptions.push({ dispose: disable });
}
