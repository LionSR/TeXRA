/**
 * How the extension's manifest presents each TeXRA command: its codicon,
 * when VS Code enables it, and whether the command palette lists it. The
 * command itself (id, title, key chord, settings page) is the app's catalog;
 * `scripts/sync-package-contributes.mjs` writes the three exports below into
 * `package.json`, and its `--check` (in `npm run gate:invariants`) fails on
 * drift.
 */

// Local imports
import {
  COMMAND_CATALOG,
  type CommandId,
} from '@texra/shared/commands/catalog';

interface CommandPresentation {
  readonly icon?: `$(${string})`;
  readonly enablement?: string;
  /**
   * `false` hides the command from VS Code's command palette: it is reached
   * from a button, a keybinding or a comment thread instead. Every other
   * command shows there once the window has activated.
   */
  readonly palette?: false;
}

/** The palette group of every command the extension contributes. */
const COMMAND_CATEGORY = 'TeXRA';

/** The context key the extension sets once every command is registered, so
 *  neither the palette nor a keybinding reaches a command that is not there
 *  yet. */
const ACTIVATED = 'texra.activated';

/** One row per catalog command, so a new command fails the type check until
 *  it says how the manifest shows it. */
const PRESENTATION = {
  'texra.createSampleProject': {},
  'texra.runSetupAssistant': { icon: '$(rocket)' },
  'texra.openGettingStarted': { icon: '$(mortar-board)' },
  'texra.cleanBuild': { icon: '$(close-all)' },
  'texra.cloneOverleafProject': { icon: '$(repo-clone)' },
  'texra.indentCurrentTeX': {
    icon: '$(indent)',
    enablement: '!virtualWorkspace',
  },
  'texra.fixCompilation': {
    icon: '$(wrench)',
    enablement: '!virtualWorkspace',
  },
  'texra.getTeXCount': {
    icon: '$(symbol-number)',
    enablement: '!virtualWorkspace',
  },
  'texra.compileTikzFigures': {},
  'texra.downloadArXivSource': {},
  'texra.execute': { palette: false },
  'texra.setApiKey': {},
  'texra.removeApiKey': { palette: false },
  'texra.auth.chatgpt.signIn': { icon: '$(comment-discussion)' },
  'texra.showMemory': { palette: false, icon: '$(database)' },
  'texra.showModels': { palette: false, icon: '$(hubot)' },
  'texra.showTools': { palette: false, icon: '$(extensions)' },
  'texra.showApprovalSettings': { palette: false, icon: '$(shield)' },
  'texra.showGitSettings': { palette: false, icon: '$(git-branch)' },
  'texra.showMainView': { icon: '$(edit)' },
  'texra.showProgressView': { icon: '$(eye)' },
  'texra.openProgressViewInTab': { icon: '$(multiple-windows)' },
  'texra.showDashboard': { icon: '$(gear)' },
  'texra.replyComment': { palette: false },
  'texra.resolveCommentThread': { palette: false, icon: '$(check)' },
  'texra.unresolveCommentThread': { palette: false, icon: '$(history)' },
} as const satisfies Record<CommandId, CommandPresentation>;

const presentation = (id: CommandId): CommandPresentation => PRESENTATION[id];

/** The manifest's `contributes.commands`, in catalog order. Field order
 *  mirrors the manifest so the sync script writes a stable diff. */
export const packageCommandContributions = COMMAND_CATALOG.map((entry) => {
  const { icon, enablement } = presentation(entry.id);
  return {
    command: entry.id,
    title: entry.title,
    ...('shortTitle' in entry && { shortTitle: entry.shortTitle }),
    category: COMMAND_CATEGORY,
    ...(icon && { icon }),
    ...(enablement && { enablement }),
  };
});

/** The manifest's `menus.commandPalette`: a `palette: false` command is
 *  never shown, every other one once the window has activated. */
export const packageCommandPalette = COMMAND_CATALOG.map((entry) => ({
  command: entry.id,
  when: presentation(entry.id).palette === false ? 'false' : ACTIVATED,
}));

/** The manifest's `contributes.keybindings`, in catalog order. */
export const commandKeybindings = COMMAND_CATALOG.flatMap((entry) =>
  'keybinding' in entry
    ? [{ command: entry.id, ...entry.keybinding, when: ACTIVATED }]
    : [],
);
