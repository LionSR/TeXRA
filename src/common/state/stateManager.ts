// Third-party imports
import * as vscode from 'vscode';

// Re-export pure-data state keys so existing `@common/state/stateManager`
// imports keep working. The actual definitions live in stateKeys.ts so
// vscode-free zones can import them via `@common/state/stateKeys` without
// loading this module (and therefore without pulling in vscode).
export {
  WorkspaceStateKey,
  GlobalStateKey,
  INSTRUCTION_PREFIX,
} from './stateKeys';

/** Workspace state manager (initialized via initializeStateManagers) */
export let workspaceSM: vscode.Memento;

/** Global state manager (initialized via initializeStateManagers) */
export let globalSM: vscode.Memento;

/** Initialize the state managers with the extension context */
export function initializeStateManagers(
  context: vscode.ExtensionContext,
): void {
  workspaceSM = context.workspaceState;
  globalSM = context.globalState;
}
