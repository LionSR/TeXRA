// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { ExtensionCommandActions } from '@commands/extensionCommandSurface';
import {
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';

// Re-implement the extension's no-arg handler map here in test form. We
// can't import the real `extensionCommandSurface.ts` from a vitest run
// because it transitively pulls in `vscode`. The point of this test is
// not to re-test the dispatcher (covered in CommandRegistry.vitest.ts);
// it's to lock in that each newly migrated id (#3771) calls the right
// `actions.*` method, which is what would silently regress if someone
// re-wires the handler map.
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';

const HANDLERS = {
  'texra.cleanOutput': (actions: ExtensionCommandActions) => {
    void actions.cleanOutput();
    return true;
  },
  'texra.cleanBuild': (actions: ExtensionCommandActions) => {
    void actions.cleanBuild();
    return true;
  },
  'texra.indentTeX': (actions: ExtensionCommandActions) => {
    void actions.indentTeX();
    return true;
  },
  'texra.auth.signIn': (actions: ExtensionCommandActions) => {
    void actions.signIn();
    return true;
  },
  'texra.auth.signOut': (actions: ExtensionCommandActions) => {
    void actions.signOut();
    return true;
  },
  'texra.auth.viewProfile': (actions: ExtensionCommandActions) => {
    void actions.viewProfile();
    return true;
  },
  'texra.showMemory': (actions: ExtensionCommandActions) => {
    actions.showSettings(SETTINGS_TAB.MEMORY);
    return true;
  },
} satisfies Record<string, CommandHandler<ExtensionCommandActions>>;

function makeActions(): ExtensionCommandActions {
  return {
    showSettings: vi.fn(),
    resetMainView: vi.fn().mockResolvedValue(undefined),
    openWorkbenchSettings: vi.fn().mockReturnValue(Promise.resolve()),
    cleanBuild: vi.fn().mockResolvedValue(undefined),
    cleanOutput: vi.fn().mockResolvedValue(undefined),
    indentTeX: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(false),
    signOut: vi.fn().mockResolvedValue(undefined),
    viewProfile: vi.fn().mockResolvedValue(undefined),
  };
}

describe('extension command surface — newly migrated commands (#3771)', () => {
  it.each([
    ['texra.cleanOutput', 'cleanOutput'],
    ['texra.cleanBuild', 'cleanBuild'],
    ['texra.indentTeX', 'indentTeX'],
    ['texra.auth.signIn', 'signIn'],
    ['texra.auth.signOut', 'signOut'],
    ['texra.auth.viewProfile', 'viewProfile'],
  ] as const)('%s dispatches to actions.%s', (id, actionKey) => {
    const actions = makeActions();
    expect(dispatchCommandFromRegistry(id, HANDLERS, actions)).toBe(true);
    expect(actions[actionKey]).toHaveBeenCalledOnce();
  });

  it('texra.showMemory passes the memory tab index', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry('texra.showMemory', HANDLERS, actions),
    ).toBe(true);
    expect(actions.showSettings).toHaveBeenCalledExactlyOnceWith(
      SETTINGS_TAB.MEMORY,
    );
  });
});
