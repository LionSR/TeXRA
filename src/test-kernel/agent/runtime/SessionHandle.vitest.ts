import '@test/support/defaultSessionTestSetup';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { TEXRA_APPROVAL_POLICY_CONFIG_KEY } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

import { closeSessionOf } from '@test/support/sessionEnd';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

function trackAgent(session: SessionHandle, runId: RunId): RunHandle {
  const handle = testRunHandle({
    runId,
    agent: 'orchestrator',
  });
  session.runs.track(handle);
  return handle;
}

describe('SessionHandle', () => {
  it.effect(
    'keeps run tracking and approval policy isolated between sessions',
    () =>
      Effect.gen(function* () {
        const a = yield* Effect.acquireRelease(createTestSession(), (session) =>
          closeSessionOf(session),
        );
        const b = yield* Effect.acquireRelease(createTestSession(), (session) =>
          closeSessionOf(session),
        );
        const isolated = generateRunId();
        const runB = generateRunId();
        const handle = trackAgent(a, isolated);
        expect(a.runs.getHandle(isolated)).toBe(handle);
        expect(b.runs.getHandle(isolated)).toBeUndefined();

        // Disposing A leaves B's separate registry untouched.
        const handleB = trackAgent(b, runB);
        // The policy is the session's own setting: a change on A writes no
        // row and leaves B's as it was.
        a.approvals.override('yolo');
        expect(a.approvals.policy()).toBe('yolo');
        expect(b.approvals.policy()).toBe('ask');
        yield* closeSessionOf(a);
        expect(a.runs.getHandle(isolated)).toBeUndefined();
        expect(b.runs.getHandle(runB)).toBe(handleB);
      }),
  );

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
        const follow = () => {};
        const service = yield* JsonStore.open(file, { follow });
        const windowB = yield* JsonStore.open(file);
        const config = new JsonConfigProvider({
          workspace: yield* JsonStore.open(`${file}.workspace`, { follow }),
          global: yield* JsonStore.open(`${file}.global`, { follow }),
          local: service,
        });
        yield* windowB.set(TEXRA_APPROVAL_POLICY_CONFIG_KEY, 'yolo');
        const roots = { ...testWorkspaceRoots(), config };
        const before = yield* createTestSession({
          roots: { ...roots, storage: `${roots.storage}/policy-before` },
        });
        expect(before.approvals.policy()).toBe('yolo');
        // Window B sets Ask; the service restarts (a fresh session over the
        // same file) while window A still shows Auto-approve. A window has
        // no door to tell the service a policy, so A's reconnect changes
        // nothing: both sessions answer with the file's value.
        yield* windowB.set(TEXRA_APPROVAL_POLICY_CONFIG_KEY, 'ask');
        expect(before.approvals.policy()).toBe('ask');
        const after = yield* createTestSession({
          roots: { ...roots, storage: `${roots.storage}/policy-after` },
        });
        expect(after.approvals.policy()).toBe('ask');
        yield* closeSessionOf(before);
        yield* closeSessionOf(after);
      }).pipe(Effect.provide(nodeFileServices)),
  );

  it.effect('finishes owner teardown before surfacing a disposal failure', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      const failure = new Error('interaction disposal failed');
      const interactions = vi
        .spyOn(session.interactions, 'dispose')
        .mockImplementation(() => {
          throw failure;
        });
      const runs = vi.spyOn(session.runs, 'dispose');
      const exit = yield* Effect.exit(closeSessionOf(session));
      expect(Exit.isFailure(exit)).toBe(true);
      // The teardown failure reaches the caller as a defect, not a typed fail.
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(
          failure,
        );
      expect(interactions).toHaveBeenCalledOnce();
      expect(runs).toHaveBeenCalled();
    }),
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
          expect(() => trackAgent(session, generateRunId())).toThrow(
            'Cannot register run work after session disposal.',
          );
        }),
      );
      yield* closeSessionOf(session);
      expect(attempted).toBe(true);
    }),
  );
});
