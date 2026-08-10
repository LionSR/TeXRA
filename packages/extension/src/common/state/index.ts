export {
  WorkspaceStateKey,
  GlobalStateKey,
  INSTRUCTION_PREFIX,
} from '@shared/state/stateKeys';

// ⚠️  VS Code-free zones must NOT import workspaceSM/globalSM/initializeStateManagers
// from this barrel — doing so pulls in 'vscode' at module load time.
// VS Code-free consumers should:
//   - import key constants from '@shared/state/stateKeys' (canonical, no vscode dependency)
//   - access state via platform() from '@platform/platform'
//     (platform().workspaceState / platform().globalState)
//   - for pre-init-tolerant access use tryWorkspaceState() / tryGlobalState()
//     from '@platform/platform'
// Only extension-host wiring (packages/extension/src/) may use these exports.
export { workspaceSM, globalSM, initializeStateManagers } from './stateManager';
export { setPendingState, consumePendingState } from './pendingStateManager';
