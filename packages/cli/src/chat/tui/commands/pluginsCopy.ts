/**
 * The `/plugins` command's own copy: its title, its switch and trust
 * prompts, and the usage and outcome of `/plugins add`. It spells the
 * terminal's slash command and its `--plugin` flag, so it is the terminal's;
 * the copy of a plugin row, which the settings view's Plugins page prints
 * too, is the app's (`@ui/copy/plugins`).
 */
import { PLUGINS_PAGE } from '@ui/copy/plugins';

export const PLUGINS_TUI = Object.freeze({
  description:
    'Switch plugins on or off. Add one: /plugins add <URL or folder>',
  compactTitle: '/plugins · Switch plugins on or off',
  switchAction: 'switch on/off',
  chooseAction: 'choose',
  trustTitle: (name: string, version: string | null) =>
    `/plugins · ${PLUGINS_PAGE.trustQuestion(name, version)}`,
  trust: 'Trust and switch on',
  decline: 'Keep it off',
  addUsage:
    'Usage: /plugins add <github.com/owner/repo[@ref], a repository URL, or a folder> [--plugin <name>]',
  added: (names: readonly string[]) =>
    `Added ${names.join(', ')}. Switch it on in /plugins to review what it declares and trust it.`,
});
