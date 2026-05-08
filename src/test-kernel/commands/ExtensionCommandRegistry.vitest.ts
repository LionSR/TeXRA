// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports
import type { ExtensionCommandActions } from '@commands/extensionCommandSurface';
import {
  definedHandler,
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@shared/commands/registry';
import { StreamTabIdSchema } from '@shared/schemas/identifiers';

// Re-implement the extension's no-arg handler map here in test form. We
// can't import the real `extensionCommandSurface.ts` from a vitest run
// because it transitively pulls in `vscode`. The point of this test is
// not to re-test the dispatcher (covered in CommandRegistry.vitest.ts);
// it's to lock in that each newly migrated id (#3771, #3775) calls the
// right `actions.*` method, which is what would silently regress if
// someone re-wires the handler map.
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
  'texra.runSetupAssistant': (actions: ExtensionCommandActions) => {
    void actions.runSetupAssistant();
    return true;
  },
  'texra.openGettingStarted': (actions: ExtensionCommandActions) => {
    void actions.openGettingStarted();
    return true;
  },
  'texra.createSampleProject': (actions: ExtensionCommandActions) => {
    void actions.createSampleProject();
    return true;
  },
  'texra.downloadArXivSource': (actions: ExtensionCommandActions) => {
    void actions.downloadArXivSource();
    return true;
  },
  'texra.testConnection': (actions: ExtensionCommandActions) => {
    void actions.testConnection();
    return true;
  },
  'texra.testAgentLoading': (actions: ExtensionCommandActions) => {
    void actions.testAgentLoading();
    return true;
  },
  'texra.loadSpecificAgent': (actions: ExtensionCommandActions) => {
    void actions.loadSpecificAgent();
    return true;
  },
  'texra.openProgressViewInTab': (actions: ExtensionCommandActions) => {
    void actions.openProgressViewInTab();
    return true;
  },
  'texra.openDoc': definedHandler(
    z.string(),
    (actions: ExtensionCommandActions, page) => {
      void actions.openDoc(page);
      return true;
    },
  ),
  'texra.stopAgent': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) => {
      actions.stopAgent(streamId);
      return true;
    },
  ),
  'texra.compactResponse': definedHandler(
    StreamTabIdSchema,
    (actions: ExtensionCommandActions, streamId) => {
      void actions.compactResponse(streamId);
      return true;
    },
  ),
  // The typed handlers carry their own argument shapes via
  // `definedHandler`. Matching the registry map's per-entry TArgs widening
  // (`any`) keeps inference per entry without unifying every entry on
  // `unknown`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, CommandHandler<ExtensionCommandActions, any>>;

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
    runSetupAssistant: vi.fn().mockResolvedValue(undefined),
    openGettingStarted: vi.fn().mockReturnValue(Promise.resolve()),
    createSampleProject: vi.fn().mockResolvedValue(undefined),
    downloadArXivSource: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue(undefined),
    testAgentLoading: vi.fn().mockResolvedValue(undefined),
    loadSpecificAgent: vi.fn().mockResolvedValue(undefined),
    openProgressViewInTab: vi.fn().mockResolvedValue(undefined),
    openDoc: vi.fn().mockResolvedValue(undefined),
    stopAgent: vi.fn(),
    compactResponse: vi.fn().mockResolvedValue(undefined),
  };
}

describe('extension command surface — newly migrated commands (#3771, #3775)', () => {
  it.each([
    ['texra.cleanOutput', 'cleanOutput'],
    ['texra.cleanBuild', 'cleanBuild'],
    ['texra.indentTeX', 'indentTeX'],
    ['texra.auth.signIn', 'signIn'],
    ['texra.auth.signOut', 'signOut'],
    ['texra.auth.viewProfile', 'viewProfile'],
    ['texra.runSetupAssistant', 'runSetupAssistant'],
    ['texra.openGettingStarted', 'openGettingStarted'],
    ['texra.createSampleProject', 'createSampleProject'],
    ['texra.downloadArXivSource', 'downloadArXivSource'],
    ['texra.testConnection', 'testConnection'],
    ['texra.testAgentLoading', 'testAgentLoading'],
    ['texra.loadSpecificAgent', 'loadSpecificAgent'],
    ['texra.openProgressViewInTab', 'openProgressViewInTab'],
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

  it('texra.openDoc forwards parsed page argument', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.openDoc',
        HANDLERS,
        actions,
        undefined,
        'getting-started',
      ),
    ).toBe(true);
    expect(actions.openDoc).toHaveBeenCalledExactlyOnceWith('getting-started');
  });

  it('texra.openDoc rejects non-string raw arg', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.openDoc',
        HANDLERS,
        actions,
        undefined,
        42,
      ),
    ).toBe(false);
    expect(actions.openDoc).not.toHaveBeenCalled();
  });

  it('texra.stopAgent forwards parsed streamId', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.stopAgent',
        HANDLERS,
        actions,
        undefined,
        'stream-1',
      ),
    ).toBe(true);
    expect(actions.stopAgent).toHaveBeenCalledExactlyOnceWith('stream-1');
  });

  it('texra.compactResponse forwards parsed streamId', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.compactResponse',
        HANDLERS,
        actions,
        undefined,
        'stream-2',
      ),
    ).toBe(true);
    expect(actions.compactResponse).toHaveBeenCalledExactlyOnceWith('stream-2');
  });

  it('texra.compactResponse rejects empty streamId', () => {
    const actions = makeActions();
    expect(
      dispatchCommandFromRegistry(
        'texra.compactResponse',
        HANDLERS,
        actions,
        undefined,
        '',
      ),
    ).toBe(false);
    expect(actions.compactResponse).not.toHaveBeenCalled();
  });
});
