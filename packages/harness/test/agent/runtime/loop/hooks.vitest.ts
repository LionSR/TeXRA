/**
 * The installed plugins' hooks at the run loop's points (`loop/hooks.ts`),
 * over a real store on the validation model, with a real installed plugin
 * whose `PreToolUse` hook rewrites a command and asks about it.
 *
 * Failure modes (R22 of the harness 1.0 release acceptance):
 * - a process killed after the rewrite committed resumes with the rewritten
 *   input as the call's identity, losing the call the model made;
 * - the resume runs the input the model asked for instead of the one the
 *   hook rewrote it to, or runs it without the person's approval;
 * - the resume runs the hook again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { assert, describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { InstalledPlugins } from '@texra-ai/harness/host';
import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { decideRequest } from '@agent/runtime/requests';
import { resumeRun } from '@agent/runtime/resumeRun';
import { rootRun } from '@agent/runtime/rootLaunch';
import {
  crashedCopy,
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  storedRows,
  type StoredRow,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

/** A file's lines, none when it is absent. Trailing whitespace is dropped:
 *  cmd.exe's `echo text >> file` writes `text \r\n`. */
const linesOf = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== '')
    : [];

/** `runId`'s rows of `type` in the store at `storage`, each payload parsed. */
const rowsOf = (storage: string, runId: RunId, type: string) =>
  storedRows(storage)
    .filter((row: StoredRow) => row.run === runId && row.type === type)
    // cast: every stored row's data is the JSON object its writer encoded.
    .map((row) => JSON.parse(row.data) as Record<string, unknown>);

/** The commands the model's own responses asked `bash` for. */
const commandsAsked = (storage: string, runId: RunId) =>
  rowsOf(storage, runId, 'model.message').flatMap((row) => {
    // cast: a `model.message` row's payload is its ModelMessagePayload.
    const { payload } = row as {
      payload: {
        kind: string;
        turn?: {
          content: readonly { kind: string; argumentsText?: string }[];
        };
      };
    };
    if (payload.kind !== 'response') return [];
    return (payload.turn?.content ?? []).flatMap((part) =>
      part.kind === 'local-call' && part.argumentsText !== undefined
        ? // cast: `bash`'s arguments, as the scripted model wrote them.
          [(JSON.parse(part.argumentsText) as { command: string }).command]
        : [],
    );
  });

/**
 * Install and trust a plugin whose `PreToolUse` hook on `Bash` records each
 * of its runs in `runs`, rewrites the command to `rewritten`, and asks the
 * person about it.
 */
const installRewriteHook = (dir: string, runs: string, rewritten: string) =>
  Effect.gen(function* () {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'hooks'));
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'rewrite-hooks', version: '1.0.0' }),
    );
    const answer = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        updatedInput: { command: rewritten },
      },
    };
    const script = `require('node:fs').appendFileSync(${JSON.stringify(runs)}, 'ran\\n'); console.log(${JSON.stringify(JSON.stringify(answer))});`;
    writeFileSync(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'node', args: ['-e', script] },
              ],
            },
          ],
        },
      }),
    );
    const { roots } = yield* FakeHost;
    yield* InstalledPlugins.install({ kind: 'local', path: dir }, [], roots);
    yield* InstalledPlugins.enable('rewrite-hooks', roots, () =>
      Effect.succeed(true),
    );
  });

describe('run loop hooks', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-hooks-'), { buildPerTest: true })((it) => {
      it.effect(
        'R22: a rewrite committed before a crash keeps the original call, runs only the rewritten input, and never runs the hook again',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const { workspace } = roots;
            assert(workspace !== undefined);
            const effects = join(workspace, 'effects.log');
            const hookRuns = join(workspace, 'hook-runs.log');
            const original = `echo original >> ${effects}`;
            const rewritten = `echo rewritten >> ${effects}`;
            yield* installRewriteHook(
              join(roots.storage, 'rewrite-hooks'),
              hookRuns,
              rewritten,
            );

            // The model asks for the original command; the hook rewrites it and
            // asks the person; the process dies while the request waits.
            const runId = generateRunId();
            const storage = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* persistentTestSession(roots);
                yield* rootRun({
                  config: Schema.decodeUnknownSync(AgentConfigSchema)({
                    agent: 'command_runner',
                    agentSource: 'inline',
                    persona: {
                      name: 'command_runner',
                      description: 'Runs one command.',
                      prompt: `GOLDEN-APPROVAL bash ${original}`,
                      tools: ['bash'],
                    },
                    model: 'openai/gpt-5.6-sol',
                    instruction: 'Run the command.',
                  }),
                  runId,
                }).pipe(Effect.provide(session));
                yield* untilStored(roots.storage, (rows) =>
                  rows.some(
                    (row) => row.run === runId && row.type === 'request.opened',
                  ),
                );
                const copy = crashedCopy(roots.storage);
                yield* Sessions.use((sessions) => sessions.close(roots));
                return copy;
              }),
            );
            expect(linesOf(hookRuns)).toEqual(['ran']);
            expect(rowsOf(storage, runId, 'hook.outcome')).toMatchObject([
              { payload: { updatedInput: { command: rewritten } } },
            ]);
            // cast: a `request.opened` row's data carries its request's id.
            const [pending] = rowsOf(storage, runId, 'request.opened') as {
              requestId: string;
            }[];
            assert(pending !== undefined);

            // A fresh process resumes the run; the person approves.
            const session = yield* persistentTestSession({ ...roots, storage });
            const resumed = yield* resumeRun(runId, {}).pipe(
              Effect.provide(session),
            );
            expect(resumed).toMatchObject({ activation: expect.any(Number) });
            expect(
              yield* decideRequest(runId, pending.requestId, {
                action: 'approve',
              }).pipe(Effect.provide(session)),
            ).toBe(true);
            yield* untilStored(
              storage,
              () => rowsOf(storage, runId, 'tool.result').length > 0,
            );
            yield* Sessions.use((sessions) =>
              sessions.close({ ...roots, storage }),
            );

            // The call is the model's own; only the rewritten command ran, once,
            // and the hook did not run again.
            expect(commandsAsked(storage, runId)).toEqual([original]);
            expect(rowsOf(storage, runId, 'tool.result')).toMatchObject([
              { payload: { disposition: 'executed' } },
            ]);
            expect(linesOf(effects)).toEqual(['rewritten']);
            expect(linesOf(hookRuns)).toEqual(['ran']);
            expect(rowsOf(storage, runId, 'hook.outcome')).toHaveLength(1);
          }),
      );
    });
  });
});
