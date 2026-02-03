// Barrel export for history commands
export { registerStateRestoreCommand } from './stateRestoreCommand';

// History commands have been merged into settingsView commands
export const historyCommands = {
  showHistory: 'texra.showAgentHistory',
} as const;
