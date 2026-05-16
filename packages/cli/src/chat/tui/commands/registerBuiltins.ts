// Registers the slash commands the Phase 5 input palette surfaces. Each is
// inline-only for now; structured-form variants (`/model`, `/status`,
// `/agent`) land in the Phase 5 follow-up.
//
// Idempotent — `registerSlashCommand` overwrites by name.

import { registerSlashCommand } from './slashRegistry';

let installed = false;

export function registerPhase5SlashCommands(): void {
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
    description: 'Switch the active agent — single-screen form in Phase 5b',
  });
  registerSlashCommand({
    name: 'model',
    description: 'Switch the active model — single-screen form in Phase 5b',
  });
  registerSlashCommand({
    name: 'status',
    description: 'Open the session status tabs — Phase 5b',
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session — separate PRD',
  });
}

/** Test seam — drops registered commands so vitests can re-register from
 *  scratch without a hot-module reload. */
export function _resetBuiltinSlashCommandsForTests(): void {
  installed = false;
}
