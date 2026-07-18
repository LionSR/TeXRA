// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { configKeyVariants } from '@shared/config/configKeys';

import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
} from '@platform/interfaces';

interface VscodeConfigInspection<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

function workspaceConfiguration(
  section?: string,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(section, null);
}

function toConfigurationTarget(
  target: ConfigTarget,
): vscode.ConfigurationTarget {
  return target === 'global'
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;
}

function normalizeInspection<T>(
  inspection: VscodeConfigInspection<T> | undefined,
  effectiveValue: T,
): ConfigInspection<T> | undefined {
  if (!inspection) return undefined;
  return {
    defaultValue: inspection.defaultValue,
    globalValue: inspection.globalValue,
    workspaceValue: inspection.workspaceValue,
    workspaceFolderValue: inspection.workspaceFolderValue,
    effectiveValue,
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
    let result: unknown = workspaceConfiguration(parts[0]).get(
      parts.slice(1).join('.'),
    );

    if (result === undefined) {
      result = workspaceConfiguration('texra').get(key);
    }
    if (result === undefined) {
      result = workspaceConfiguration().get(`texra.${key}`);
    }

    return result !== undefined ? (result as T) : (defaultValue as T);
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    // `configUtils.updateConfig` owns prefix policy, including explicit
    // `prefix: false` writes. Preserve the exact key passed to this adapter.
    await workspaceConfiguration().update(
      key,
      value,
      toConfigurationTarget(target),
    );
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    const inspection = configKeyVariants(key)
      .map((item) => workspaceConfiguration().inspect<T>(item))
      .find((item) => item !== undefined);
    return normalizeInspection(inspection, this.get<T>(key));
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
        if (
          configKeyVariants(key).some((item) =>
            event.affectsConfiguration(item),
          )
        ) {
          listener();
        }
        return;
      }
      if (Array.isArray(key)) {
        if (
          key.some((item) =>
            configKeyVariants(item).some((candidate) =>
              event.affectsConfiguration(candidate),
            ),
          )
        ) {
          listener();
        }
        return;
      }

      // VS Code does not expose changed keys. Regex watchers are rare and
      // should conservatively refresh on any configuration change.
      listener();
    });
  }
}
