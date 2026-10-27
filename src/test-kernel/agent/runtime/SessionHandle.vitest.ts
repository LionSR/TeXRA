import '@test/support/defaultSessionTestSetup';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';
import { registryOf } from '@agent/runtime/runRegistry';

import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { APPROVAL_POLICY_CONFIG_KEY } from '@shared/approvalPolicy';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

import { closeSessionOf } from '@test/support/sessionEnd';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { generateRunId } from '@utils/core';

describe('SessionHandle', () => {
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
        const follow = true;
        const service = yield* JsonStore.open(file, { follow });
        const windowB = yield* JsonStore.open(file);
        const config = new JsonConfigProvider({
          workspace: yield* JsonStore.open(`${file}.workspace`, { follow }),
          global: yield* JsonStore.open(`${file}.global`, { follow }),
          local: service,
          catalog: TEXRA_SETTINGS,
        });
        yield* windowB.set(APPROVAL_POLICY_CONFIG_KEY, 'yolo');
        const roots = { ...testWorkspaceRoots(), config };
        const before = yield* createTestSession({
          roots: { ...roots, storage: `${roots.storage}/policy-before` },
        });
        expect(before.approvals.policy()).toBe('yolo');
        // Window B sets Ask; the service restarts (a fresh session over the
        // same file) while window A still shows Auto-approve. A window has
        // no door to tell the service a policy, so A's reconnect changes
        // nothing: both sessions answer with the file's value.
        yield* windowB.set(APPROVAL_POLICY_CONFIG_KEY, 'ask');
        expect(before.approvals.policy()).toBe('ask');
        const after = yield* createTestSession({
          roots: { ...roots, storage: `${roots.storage}/policy-after` },
        });
        expect(after.approvals.policy()).toBe('ask');
        yield* closeSessionOf(before);
        yield* closeSessionOf(after);
      }).pipe(Effect.provide(nodeFileServices)),
  );

  it.effect('refuses run work once disposal has begun', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      let attempted = false;
      // The handle's owners unwind after the session's runs: a launch reaching
      // the registry from inside that unwind is already refused.
      vi.spyOn(session.interactions, 'dispose').mockImplementation(() =>
        Effect.sync(() => {
          attempted = true;
          expect(() =>
            registryOf(session.runs).track(
              testRunHandle({ runId: generateRunId(), agent: 'orchestrator' }),
            ),
          ).toThrow('Cannot register run work after session disposal.');
        }),
      );
      yield* closeSessionOf(session);
      expect(attempted).toBe(true);
    }),
  );
});
