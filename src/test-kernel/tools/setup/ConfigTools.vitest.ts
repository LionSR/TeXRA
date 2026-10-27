// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import { closeSessionOf } from '@test/support/sessionEnd';
import { createFakeHost } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  autoDecideRequests,
  createRecordingHost,
  sessionWithInteractions,
} from '@test/agent/progressTestUtils';
import { UpdateConfigTool } from '@texra/tools/setup/ConfigTools';
import { generateRunId } from '@utils/core';

describe('ConfigTools — update_config allowlist', () => {
  it.effect('rejects a non-allowlisted key without writing', () =>
    Effect.gen(function* () {
      const { roots } = createFakeHost();

      const key = 'texra.model.useGoogleInteractionsServerState';
      const result = yield* UpdateConfigTool.call({
        key,
        value: true,
        target: 'user',
      }).pipe(Effect.provide(nativeToolTestLayer({ roots })));

      assert.equal(result.status, 'error');
      assert.deepEqual(
        roots.config.inspect(key),
        { globalValue: undefined, workspaceValue: undefined },
        'must not write rejected settings',
      );
    }),
  );
});

describe('ConfigTools — update_config approval', () => {
  // `requiresApproval: true` means the run loop asks before the body runs.
  // Failure modes: the body writes with no request at all (the tool only
  // declared approval), the body writes although the request was rejected,
  // or the call is asked about twice.
  it.live('asks before writing, and a rejected call writes nothing', () =>
    Effect.gen(function* () {
      const project = createFakeHost({
        config: { 'texra.bib.zoteroPort': 23119 },
      });
      const session = yield* Effect.acquireRelease(
        sessionWithInteractions(createRecordingHost().interactions),
        (session) => closeSessionOf(session),
      );
      const runId = generateRunId();
      publishTestRunStart(session, runId);
      yield* session.log.settled;
      const requests = yield* Effect.acquireRelease(
        Effect.sync(() =>
          autoDecideRequests(session, () => ({ action: 'reject' })),
        ),
        (requests) => Effect.sync(() => requests.detach()),
      );

      const result = yield* guardedToolCall(UpdateConfigTool, {
        key: 'texra.bib.zoteroPort',
        value: 23200,
        target: 'user',
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            roots: project.roots,
            run: { session, runId, toolPolicy: {} },
          }),
        ),
      );

      expect(
        requests.opened.map(({ payload }) =>
          payload.kind === 'bash' ? payload.data.command : payload.kind,
        ),
      ).toEqual([
        'update_config {"key":"texra.bib.zoteroPort","value":23200,"target":"user"}',
      ]);
      expect(result.status).toBe('error');
      expect(project.roots.config.get('texra.bib.zoteroPort')).toBe(23119);
    }),
  );
});
