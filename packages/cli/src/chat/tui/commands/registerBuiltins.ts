// Registers the slash commands the input palette surfaces.
//
// Idempotent — `registerSlashCommand` overwrites by name.

import { registerSlashCommand } from './slashRegistry';

let installed = false;

export function registerBuiltinSlashCommands(): void {
  if (installed) return;
  installed = true;

  registerSlashCommand({
    name: 'help',
    description: 'Show available slash commands',
  });
  registerSlashCommand({
    name: 'clear',
    description: 'Clear the screen (scrollback preserved)',
  });
  registerSlashCommand({
    name: 'agent',
    description: 'Switch the active agent',
  });
  registerSlashCommand({
    name: 'model',
    description: 'Switch the active model',
  });
  registerSlashCommand({
    name: 'status',
    description: 'Open the session status tabs',
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session — separate PRD',
  });
}
