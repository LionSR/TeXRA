// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Context } from 'effect';
import { expect } from 'vitest';

// Local imports
import { generateRunId } from '@texra-ai/harness/schemas';
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import { SessionLog } from '@shared/session/runHistory';
import { createFakeHost } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';
import {
  autoDecideRequests,
  createRecordingHost,
} from '@test/agent/progressTestUtils';
import { UpdateConfigTool } from '@texra/tools/setup/ConfigTools';

layer(SessionGraph.hosted)('ConfigTools — update_config allowlist', (it) => {
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
        roots.config.inspect(key.slice('texra.'.length)),
        { globalValue: undefined, workspaceValue: undefined },
        'must not write rejected settings',
      );
    }),
  );
});

// Live clock: a real request is opened and answered on the session's log.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'ConfigTools — update_config approval',
  (it) => {
    // `requiresApproval: true` means the run loop asks before the body runs.
    // Failure modes: the body writes with no request at all (the tool only
    // declared approval), the body writes although the request was rejected,
    // or the call is asked about twice.
    it.effect('asks before writing, and a rejected call writes nothing', () =>
      Effect.gen(function* () {
        const project = createFakeHost({
          config: { 'bib.zoteroPort': 23119 },
        });
        const session = yield* isolatedTestSession(
          createRecordingHost().interactions,
        );
        const runId = generateRunId();
        publishTestRunStart(session, runId);
        yield* Context.get(session, SessionLog).settled;
        const requests = yield* autoDecideRequests(session, () => ({
          action: 'reject',
        }));

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
        expect(project.roots.config.get('bib.zoteroPort')).toBe(23119);
      }),
    );
  },
);
