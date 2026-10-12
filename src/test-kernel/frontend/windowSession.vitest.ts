// Node imports
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Result, SubscriptionRef } from 'effect';
import { describe, expect } from 'vitest';

import { SessionOwner, Sessions } from '@texra-ai/harness';
import type { ServiceClient } from '@texra/controllers/server/client';
import { TEXRA_SETTING_ROWS } from '@texra/shared/settingsView/texraSettings';
import { createFakeWorkspaceRoots } from '../support/FakePlatform';
import { testProcessLayer } from '../support/sessionGraphInstall';
import { openWindowSession } from '../../../packages/extension/src/windowSession';

/**
 * A window decides once where its runs run. Failure modes guarded: a
 * window of the service opens a session of its own beside it (a second
 * owner of the project's runs, its log and claims), or tells the user its
 * tasks run here; a window that cannot reach the service opens no session
 * of its own, or says so more than once.
 */
describe('openWindowSession', () => {
  const temp = (prefix: string) =>
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), `texra-${prefix}-`))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );

  /** The window's session over the kernel's real process composition, with
   *  the notices it showed and the sessions its owner holds after. */
  const open = (reached: 'reached' | 'unreachable') =>
    Effect.gen(function* () {
      const process = yield* Layer.buildWithMemoMap(
        testProcessLayer([], TEXRA_SETTING_ROWS, yield* temp('global')),
        Layer.makeMemoMapUnsafe(),
        yield* Effect.scope,
      );
      const roots = createFakeWorkspaceRoots({
        storagePath: yield* temp('storage'),
      });
      const notices: string[] = [];
      const reach =
        reached === 'reached'
          ? Result.succeed({
              client: yield* SubscriptionRef.make<ServiceClient | null>(null),
            })
          : Result.fail(new Error('no service'));
      const window = yield* openWindowSession(
        reach,
        roots,
        Context.get(process, Sessions),
        (message) => Effect.sync(() => notices.push(message)),
      ).pipe(Effect.provideContext(process));
      const held = yield* Context.get(process, SessionOwner).list;
      return { window, notices, held };
    }).pipe(Effect.scoped);

  it.live('opens no session of its own when the service is reached', () =>
    Effect.gen(function* () {
      const { window, notices, held } = yield* open('reached');
      expect(window.handle).toBeUndefined();
      expect(held).toEqual([]);
      expect(notices).toEqual([]);
    }),
  );

  it.live('runs here, and says so once, when the service is not reached', () =>
    Effect.gen(function* () {
      const { window, notices, held } = yield* open('unreachable');
      expect(held).toHaveLength(1);
      expect(held[0]).toBe(window.handle);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('runs this window');
    }),
  );
});
