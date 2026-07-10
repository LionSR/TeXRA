/**
 * Internal KV metadata files stored alongside an execution's generated
 * output. Shared by run-directory listing (`runDirectoryFiles.ts`) and the
 * CLI's history file listing (`packages/cli/src/runtime/history/generatedFiles.ts`)
 * so the two stay in sync on what counts as internal metadata.
 */
const KV_FILES = new Set([
  'meta.json',
  'config.json',
  'conversation.json',
  'todos.json',
  'report.json',
  'workspace-files.json',
  'result-meta.json',
]);

export function isKVFile(name: string): boolean {
  return (
    KV_FILES.has(name) || name.startsWith('child-') || name.startsWith('flow_')
  );
}
