import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Context } from 'effect';
import { expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import {
  APPROVAL_POLICY_SETTING,
  generateRunId,
} from '@texra-ai/harness/schemas';
import {
  JsonConfigProvider,
  JsonStore,
  nodeFileServices,
} from '@texra-ai/harness/node';
import { RunRegistry } from '@agent/runtime/runRegistry';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import { Approvals } from '@shared/session/runHistory';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'Context.Context<SessionServices>',
  (it) => {
    it.effect(
      "follows the project's persisted policy, which a reconnecting window cannot replace",
      () =>
        Effect.gen(function* () {
          // The service's config stores follow the user's local config file;
          // window B's settings view writes that file through its own store.
          const file = path.join(
            mkdtempSync(path.join(tmpdir(), 'policy-')),
            'c.json',
          );
          const service = yield* JsonStore.open(file);
          const windowB = yield* JsonStore.open(file);
          // The file holds the key as stored, under the catalog's namespace.
          const STORED_POLICY_KEY = `${TEXRA_SETTINGS.catalog.namespace}.${APPROVAL_POLICY_SETTING.key}`;
          const config = new JsonConfigProvider({
            workspace: yield* JsonStore.open(`${file}.workspace`),
            global: yield* JsonStore.open(`${file}.global`),
            local: service,
            catalog: TEXRA_SETTINGS.catalog,
          });
          yield* windowB.set(STORED_POLICY_KEY, 'yolo');
          const roots = { ...(yield* FakeHost).roots, config };
          const before = yield* Effect.flatMap(
            TestSession.open({
              ...roots,
              storage: `${roots.storage}/policy-before`,
            }),
            sessionHandleOf,
          );
          expect(Context.get(before, Approvals).policy()).toBe('yolo');
          // Window B sets Ask; the service restarts (a fresh session over the
          // same file) while window A still shows Auto-approve. A window has
          // no door to tell the service a policy, so A's reconnect changes
          // nothing: both sessions answer with the file's value.
          yield* windowB.set(STORED_POLICY_KEY, 'ask');
          expect(Context.get(before, Approvals).policy()).toBe('ask');
          const after = yield* Effect.flatMap(
            TestSession.open({
              ...roots,
              storage: `${roots.storage}/policy-after`,
            }),
            sessionHandleOf,
          );
          expect(Context.get(after, Approvals).policy()).toBe('ask');
        }).pipe(Effect.provide(nodeFileServices)),
    );

    it.effect('refuses run work once disposal has begun', () =>
      Effect.gen(function* () {
        let refusal: string | undefined;
        // The handle's owners unwind after the session's runs: run work
        // reaching the registry from inside that unwind (the attached host's
        // disposal) is already refused.
        const session: Context.Context<SessionServices> =
          yield* isolatedTestSession({
            dispose: () => {
              refusal = Effect.runSync(
                Context.get(session, RunRegistry)
                  .start(generateRunId(), {
                    open: Effect.void,
                    run: () => Effect.never,
                  })
                  .pipe(Effect.flip, Effect.orDie),
              ).message;
            },
          });
        yield* (yield* Sessions).close(Context.get(session, SessionRoots));
        expect(refusal).toBe(
          'Cannot register run work after session disposal.',
        );
      }),
    );
  },
);
