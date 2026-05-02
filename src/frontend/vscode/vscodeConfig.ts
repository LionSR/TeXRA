// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces/config';

interface VscodeConfigInspection<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

function toConfigurationTarget(
  target: ConfigTarget,
): vscode.ConfigurationTarget {
  return target === 'global'
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;
}

function normalizeInspection<T>(
  key: string,
  inspection: VscodeConfigInspection<T> | undefined,
): ConfigInspection<T> | undefined {
  if (!inspection) return undefined;
  return {
    defaultValue: inspection.defaultValue,
    globalValue: inspection.globalValue,
    workspaceValue: inspection.workspaceValue,
    workspaceFolderValue: inspection.workspaceFolderValue,
    effectiveValue: vscode.workspace.getConfiguration().get<T>(key),
  };
}

/**
 * VS Code-backed implementation of TeXRA's host-neutral config provider.
 */
export class VscodeConfigProvider implements ConfigProvider {
  get<T>(key: string, defaultValue?: T): T {
    const parts = key.split('.');

    // Try multiple namespaces in order of priority (using === undefined to
    // preserve null values).
    let result: unknown = vscode.workspace
      .getConfiguration(parts[0])
      .get(parts.slice(1).join('.'));

    if (result === undefined) {
      result = vscode.workspace.getConfiguration('texra').get(key);
    }
    if (result === undefined) {
      result = vscode.workspace.getConfiguration().get(`texra.${key}`);
    }

    return result !== undefined ? (result as T) : (defaultValue as T);
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration()
      .update(key, value, toConfigurationTarget(target));
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    return normalizeInspection(
      key,
      vscode.workspace.getConfiguration().inspect<T>(key),
    );
  }

  isExplicitlySet(key: string): boolean {
    const inspection = this.inspect(key);
    if (!inspection) return false;
    return (
      inspection.globalValue !== undefined ||
      inspection.workspaceValue !== undefined ||
      inspection.workspaceFolderValue !== undefined
    );
  }

  watch(
    key: string | readonly string[] | RegExp,
    listener: () => void,
  ): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (typeof key === 'string') {
        if (event.affectsConfiguration(key)) listener();
        return;
      }
      if (Array.isArray(key)) {
        if (key.some((item) => event.affectsConfiguration(item))) listener();
        return;
      }

      // VS Code does not expose changed keys. Regex watchers are rare and
      // should conservatively refresh on any configuration change.
      listener();
    });
  }
}
