// Third-party imports
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports
import {
  EXTENSION_COMMAND_HANDLERS,
  type ExtensionCommandActions,
} from '@commands/extensionCommandHandlers';
import { dispatchCommandFromRegistry } from '@texra/shared/commands/registry';

// `extensionCommandHandlers.ts` is deliberately free of `vscode` imports, so
// the production handler map is exercised directly here. Only
// `packages/extension/src/commands.ts`, which wires the real actions against VS Code
// APIs, needs the extension host.

// Settles the handler's program the way the registration boundary does (the
// test programs need no services).
function dispatch(
  actions: ExtensionCommandActions,
  id: keyof typeof EXTENSION_COMMAND_HANDLERS,
): Promise<unknown> {
  const program = dispatchCommandFromRegistry(
    id,
    EXTENSION_COMMAND_HANDLERS,
    actions,
    undefined,
  );
  return program === false
    ? Promise.resolve(false)
    : Effect.runPromise(program as Effect.Effect<unknown, Error>);
}

describe('extension command surface', () => {
  // Regression guard for #3782: handlers must propagate async rejections
  // instead of swallowing them through `void actions.X(); return true;`, so
  // settling the program surfaces the rejection to `executeCommand` callers.
  it('texra.showMemory rejection bubbles up (#3782)', async () => {
    const failure = new Error('boom');
    const noop = () => Effect.void;
    const actions: ExtensionCommandActions = {
      showSettings: () => Effect.fail(failure),
      newTask: noop,
      cleanBuild: noop,
      signInChatGpt: noop,
      runSetupAssistant: noop,
      openGettingStarted: noop,
      createSampleProject: noop,
      downloadArXivSource: noop,
      openProgressViewInTab: noop,
      openDoc: noop,
      indentCurrentTeX: noop,
      fixCompilation: noop,
      getTeXCount: noop,
      compileTikzFigures: noop,
      cloneOverleafProject: noop,
      removeApiKey: noop,
      showProgressView: noop,
      setApiKey: noop,
      execute: noop,
    };

    await expect(dispatch(actions, 'texra.showMemory')).rejects.toBe(failure);
  });
});
