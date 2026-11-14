import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect, vi } from 'vitest';
import * as vscode from 'vscode';

import { createExtensionHostRequests } from '@progressView/extensionHostRequests';

it.effect('fails with the URL when VS Code declines to open a link', () =>
  Effect.gen(function* () {
    // VS Code answers `false`, without throwing, for a URL no handler takes.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    // cast: the link binding reads none of the window's options.
    const { bindings } = yield* createExtensionHostRequests({
      roots: {},
      snapshot: {},
      extensionPath: '',
    } as unknown as Parameters<typeof createExtensionHostRequests>[0]);

    // cast: opening a link needs none of the services a host verb may use.
    const open = bindings.openExternal(
      'https://texra.ai/guide/custom-agents',
    ) as unknown as Effect.Effect<void, Error>;
    const error = yield* Effect.flip(open);

    expect(error.message).toContain('https://texra.ai/guide/custom-agents');
  }).pipe(Effect.scoped),
);
