// Registers the slash commands the input palette surfaces.
//
// Idempotent at the call-site granularity: the module-scope `installed`
// flag short-circuits repeat invocations, so registrations that were
// individually unregistered won't reappear without a process restart.

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
    description: 'Resume a previous session',
  });
}

/** Test seam — drops registered commands so vitests can re-register from
 *  scratch without a hot-module reload. */
export function _resetBuiltinSlashCommandsForTests(): void {
  installed = false;
}
