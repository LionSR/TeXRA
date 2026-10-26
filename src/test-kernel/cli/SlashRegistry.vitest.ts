// Slash command registry and parse helpers.

// Test composition imports

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeAll, describe, expect } from 'vitest';

import {
  findSlashCommand,
  matchSlashCommands,
  parseSlashInput,
  prefixSlashCommands,
  type SlashCommand,
  installSlashCommands,
} from '@cli/chat/tui/commands/slashRegistry';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { openRegisteredCliSlashForm } from '@cli/chat/tui/commands/slashForms';
import { type AccountAccessFormValue } from '@cli/chat/tui/forms/AccountAccessForm';
import {
  formProgress,
  resetCliState,
  transientNotice,
} from '@cli/chat/tui/state/cliState';
import { activeForm, closeActiveForm } from '@cli/chat/tui/state/formSlot';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { bindTestSessionView } from './fixtures/sessionViewFixture';

/**
 * Register the built-ins with the process stores the chat surface threads in.
 * These suites drive the form handlers, never the stores, so one fake pair
 * serves the whole file.
 */
function registerBuiltins(
  options: Omit<
    Parameters<typeof registerBuiltinSlashCommands>[0],
    'secrets' | 'stores' | 'runtime' | 'runtimeSession' | 'runSession'
  > = {},
): void {
  registerBuiltinSlashCommands({
    secrets: new FakeSecrets(),
    stores: makeFakeSettingsStores('cli').stores,
    runtime: testRuntime(),
    runtimeSession: testSessionOf(testDefaultSession()),
    runSession: testSessionOf(testDefaultSession()),
    ...options,
  });
}

afterEach(() => {
  installSlashCommands([]);
  resetCliState();
});

describe('slashRegistry', () => {
  beforeAll(bindTestSessionView);
  function renderFormAdapter<TProps>(node: unknown): { props?: TProps } {
    // The slot renders the form inside the surface that swaps in the busy
    // frame; the adapter is its child.
    const element = (node as { props?: { children?: unknown } }).props
      ?.children as {
      type?: (props: unknown) => unknown;
      props?: unknown;
    };
    if (typeof element.type !== 'function') {
      throw new TypeError('Expected registered slash form adapter element');
    }
    return element.type(element.props) as { props?: TProps };
  }

  function requireSlashCommand(name: string): SlashCommand {
    const command = findSlashCommand(name);
    if (!command) throw new Error(`Expected /${name} to be registered`);
    return command;
  }

  /** Open a registered slash command's form and render its adapter node. */
  function openSlashForm<TProps>(name: string): {
    readonly props?: TProps;
    readonly isClosed: () => boolean;
  } {
    expect(openRegisteredCliSlashForm(requireSlashCommand(name), '')).toBe(
      true,
    );
    return renderOpenForm<TProps>();
  }

  function renderOpenForm<TProps>(): {
    readonly props?: TProps;
    readonly isClosed: () => boolean;
  } {
    let closed = false;
    const form = activeForm.get();
    // Close through the slot owner, as `App` does.
    const node = renderFormAdapter<TProps>(
      form?.render(() => {
        closed = true;
        closeActiveForm(form);
      }, 20),
    );
    return {
      props: node.props,
      isClosed: () => closed,
    };
  }

  it('interrupts the running action when a busy form is cancelled', async () => {
    let interrupted = false;
    registerBuiltins({
      onLogoutSelect: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    });

    const accountNode = openSlashForm<{
      onSelect?: (value: AccountAccessFormValue) => void;
    }>('login');
    accountNode.props?.onSelect?.({ kind: 'logout', target: 'all' });
    formProgress.get()?.cancel();

    await waitFor(() => interrupted);
    expect(transientNotice.get()).toBeUndefined();
  });

  it('matches by name prefix case-insensitively', () => {
    installSlashCommands([
      {
        pluginId: 'test',
        commands: [
          { name: 'model', description: 'pick a model' },
          { name: 'agent', description: 'pick an agent' },
          { name: 'merge', description: 'merge outputs' },
        ],
      },
    ]);
    expect(matchSlashCommands('m').map((c) => c.name)).toEqual([
      'model',
      'merge',
    ]);
    expect(matchSlashCommands('Mo').map((c) => c.name)).toEqual(['model']);
    expect(matchSlashCommands('').map((c) => c.name)).toEqual([
      'model',
      'agent',
      'merge',
    ]);
  });

  it('falls back to substring matches when no prefix matches', () => {
    installSlashCommands([
      {
        pluginId: 'test',
        commands: [
          { name: 'model', description: 'pick a model' },
          { name: 'agent', description: 'pick an agent' },
        ],
      },
    ]);

    expect(matchSlashCommands('odel').map((c) => c.name)).toEqual(['model']);
    expect(matchSlashCommands('gen').map((c) => c.name)).toEqual(['agent']);
    // Prefix matches still win outright when present.
    expect(matchSlashCommands('mo').map((c) => c.name)).toEqual(['model']);
  });

  it('falls back to the typo suggestion when nothing matches literally', () => {
    installSlashCommands([
      {
        pluginId: 'test',
        commands: [
          { name: 'help', description: 'show help' },
          { name: 'model', description: 'pick a model' },
        ],
      },
    ]);

    expect(matchSlashCommands('hlp').map((c) => c.name)).toEqual(['help']);
    expect(matchSlashCommands('frobnicate')).toEqual([]);
  });

  it('keeps the auto-run tier prefix-only so fallbacks never fire blind', () => {
    installSlashCommands([
      {
        pluginId: 'test',
        commands: [
          { name: 'help', description: 'show help' },
          { name: 'model', description: 'pick a model' },
        ],
      },
    ]);

    expect(prefixSlashCommands('mo').map((c) => c.name)).toEqual(['model']);
    // Substring ('odel') and typo ('hlp') matches are palette-only.
    expect(prefixSlashCommands('odel')).toEqual([]);
    expect(prefixSlashCommands('hlp')).toEqual([]);
  });
});

describe('parseSlashInput', () => {
  it('never treats TeX-style backslash tokens as commands', () => {
    expect(parseSlashInput('\\clear')).toBeUndefined();
    expect(parseSlashInput('\\goal')).toBeUndefined();
    expect(parseSlashInput('\\alpha + \\beta')).toBeUndefined();
  });

  it('splits the command name from its remainder', () => {
    expect(parseSlashInput('/model anthropic claude')).toEqual({
      name: 'model',
      remainder: 'anthropic claude',
    });
    expect(parseSlashInput('/help')).toEqual({ name: 'help', remainder: '' });
    expect(parseSlashInput('/agent  reasoner')).toEqual({
      name: 'agent',
      remainder: ' reasoner',
    });
  });

  it('treats non-command-shaped leading tokens as chat messages', () => {
    // Pasted absolute paths.
    expect(parseSlashInput('/Users/me/poster/mpq_logo.pdf')).toBeUndefined();
    expect(
      parseSlashInput('/Users/me/poster/mpq_logo.pdf just use this then'),
    ).toBeUndefined();
    expect(parseSlashInput('/tmp/figure.png looks wrong')).toBeUndefined();
    // Single-segment tokens with characters no command name contains.
    expect(parseSlashInput('/mpq_logo.pdf')).toBeUndefined();
    expect(parseSlashInput('/3.14 is pi')).toBeUndefined();
    expect(parseSlashInput('/(a+b)')).toBeUndefined();
  });
});
