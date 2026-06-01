export {
  WorkspaceStateKey,
  GlobalStateKey,
  INSTRUCTION_PREFIX,
} from './stateKeys';

// ⚠️  VS Code-free zones must NOT import workspaceSM/globalSM/initializeStateManagers
// from this barrel — doing so pulls in 'vscode' at module load time.
// VS Code-free consumers should:
//   - import keys from '@common/state/stateKeys' (this file only exports enums)
//   - access state via platform() from '@platform/platform' or the facades in
//     '@agent/core/stateStore' (getWorkspaceState / getGlobalState)
// Only extension-host wiring (packages/extension/src/) may use these exports.
export { workspaceSM, globalSM, initializeStateManagers } from './stateManager';
export {
  setPendingState,
  consumePendingState,
  type PendingStateData,
} from './pendingStateManager';
