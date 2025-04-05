import * as vscode from 'vscode';

export function getConfig<T>(path: string, defaultValue?: T): T {
  const parts = path.split('.');

  // First try getting the config as is (e.g., for latex.latexindentConfig)
  let result: any = vscode.workspace
    .getConfiguration(parts[0])
    .get(parts.slice(1).join('.'));

  // If not found, try under texra namespace
  if (result === undefined) {
    result = vscode.workspace.getConfiguration('texra').get(path);
  }

  // If still not found, try with explicit texra prefix
  if (result === undefined) {
    result = vscode.workspace.getConfiguration().get(`texra.${path}`);
  }

  // Return default value if still undefined
  return result !== undefined ? result : (defaultValue as T);
}
