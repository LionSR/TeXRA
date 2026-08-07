// Third-party imports
import * as vscode from 'vscode';

/** Read a VS Code setting rather than a native TeXRA setting. */
export function getVscodeHostConfig<T>(
  key: string,
  defaultValue?: T,
): T | undefined {
  return vscode.workspace.getConfiguration().get(key, defaultValue);
}

/** Inspect a VS Code setting at each configuration scope. */
export function inspectVscodeHostConfig<T>(key: string) {
  return vscode.workspace.getConfiguration().inspect<T>(key);
}

/** Whether a VS Code setting has an explicit value at any user scope. */
export function isVscodeHostConfigExplicitlySet(key: string): boolean {
  const inspection = inspectVscodeHostConfig(key);
  return (
    inspection?.globalValue !== undefined ||
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined
  );
}

/** Write a VS Code setting at user or workspace scope. */
export async function updateVscodeHostConfig<T>(
  key: string,
  value: T,
  target: 'global' | 'workspace' = 'workspace',
): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(
      key,
      value,
      target === 'global'
        ? vscode.ConfigurationTarget.Global
        : vscode.ConfigurationTarget.Workspace,
    );
}
