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
import {
  ReadConfigTool,
  UpdateConfigTool,
} from '@texra/tools/setup/ConfigTools';
import { generateRunId } from '@utils/core';

const readTool = ReadConfigTool;
const updateTool = UpdateConfigTool;

function createPlatform(initial: Record<string, unknown> = {}) {
  const project = createFakeHost({ config: initial });
  const layer = nativeToolTestLayer({ roots: project.roots });
  return { config: project.roots.config, layer };
}

describe('ConfigTools — read_config', () => {
  it.effect('rejects keys not starting with texra.', () =>
    Effect.gen(function* () {
      const { layer } = createPlatform();

      const result = yield* readTool
        .call({ key: 'editor.fontSize' })
        .pipe(Effect.provide(layer));

      assert.equal(result.status, 'error');
    }),
  );
});

describe('ConfigTools — update_config allowlist', () => {
  it.effect('writes an allowlisted key when the value matches its schema', () =>
    Effect.gen(function* () {
      const { config, layer } = createPlatform({
        'texra.bib.zoteroPort': 23119,
      });

      const result = yield* updateTool
        .call({
          key: 'texra.bib.zoteroPort',
          value: 23200,
          target: 'user',
        })
        .pipe(Effect.provide(layer));

      assert.equal(result.status, 'executed');
      assert.equal(config.get('texra.bib.zoteroPort'), 23200);
      assert.equal(config.inspect('texra.bib.zoteroPort')?.globalValue, 23200);
      // Output reports both before and after values for the educative summary.
      assert.match(result.output ?? '', /23119/);
      assert.match(result.output ?? '', /23200/);
    }),
  );

  it.effect.each([
    {
      case: 'a non-allowlisted key',
      key: 'texra.model.useGoogleInteractionsServerState',
      value: true,
    },
    {
      case: 'a type-mismatched value',
      key: 'texra.bib.zoteroPort',
      value: 'not a number',
    },
    // Port range is 1..65535
    { case: 'port 0', key: 'texra.bib.zoteroPort', value: 0 },
    { case: 'port 70000', key: 'texra.bib.zoteroPort', value: 70000 },
  ])('rejects $case without writing', ({ key, value }) =>
    Effect.gen(function* () {
      const { config, layer } = createPlatform();

      const result = yield* updateTool
        .call({ key, value, target: 'user' })
        .pipe(Effect.provide(layer));

      assert.equal(result.status, 'error');
      assert.deepEqual(
        config.inspect(key),
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
      yield* session.settlePublications();
      const requests = yield* Effect.acquireRelease(
        Effect.sync(() =>
          autoDecideRequests(session, () => ({ action: 'reject' })),
        ),
        (requests) => Effect.sync(() => requests.detach()),
      );

      const result = yield* guardedToolCall(updateTool, {
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
