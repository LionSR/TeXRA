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
import '@test/support/sessionGraphTestSetup';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Context, Effect, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { InstalledPlugins, withProcessServices } from '@texra-ai/harness/host';
import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import { resumeRun } from '@agent/runtime/resumeRun';
import { rootRun } from '@agent/runtime/rootLaunch';
import {
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import {
  crashedCopy,
  REAL_RUN_TIMEOUT,
  storedRows,
  type StoredRow,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

/** A file's lines, none when it is absent. */
const linesOf = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];

/** `runId`'s rows of `type` in the store at `storage`, each payload parsed. */
const rowsOf = (storage: string, runId: RunId, type: string) =>
  storedRows(storage)
    .filter((row: StoredRow) => row.run === runId && row.type === type)
    .map((row) => JSON.parse(row.data) as Record<string, unknown>);

/** The commands the model's own responses asked `bash` for. */
const commandsAsked = (storage: string, runId: RunId) =>
  rowsOf(storage, runId, 'model.message').flatMap((row) => {
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
        ? [(JSON.parse(part.argumentsText) as { command: string }).command]
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
    const roots = testWorkspaceRoots();
    yield* withProcessServices(
      testRuntime(),
      Effect.gen(function* () {
        yield* InstalledPlugins.install(
          { kind: 'local', path: dir },
          [],
          roots,
        );
        yield* InstalledPlugins.enable('rewrite-hooks', roots, () =>
          Effect.succeed(true),
        );
      }),
    );
  });

describe('run loop hooks', { timeout: REAL_RUN_TIMEOUT }, () => {
  validationHost('texra-hooks-');

  it.live(
    'R22: a rewrite committed before a crash keeps the original call, runs only the rewritten input, and never runs the hook again',
    () =>
      Effect.gen(function* () {
        const roots = testWorkspaceRoots();
        const effects = join(roots.workspace!, 'effects.log');
        const hookRuns = join(roots.workspace!, 'hook-runs.log');
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
            const session = yield* openTestDefaultSession({ roots });
            yield* withProcessServices(
              testRuntime(),
              rootRun({
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
              }).pipe(Effect.provide(session)),
            );
            yield* untilStored(roots.storage, (rows) =>
              rows.some(
                (row) => row.run === runId && row.type === 'request.opened',
              ),
            );
            const copy = crashedCopy(roots.storage);
            yield* closeTestSession(roots.storage);
            return copy;
          }),
        );
        expect(linesOf(hookRuns)).toEqual(['ran']);
        expect(rowsOf(storage, runId, 'hook.outcome')).toMatchObject([
          { payload: { updatedInput: { command: rewritten } } },
        ]);
        const [pending] = rowsOf(storage, runId, 'request.opened') as {
          requestId: string;
        }[];

        // A fresh process resumes the run; the person approves.
        const session = yield* openTestDefaultSession({
          roots: { ...roots, storage },
        });
        const resumed = yield* withProcessServices(
          testRuntime(),
          resumeRun(runId, {}).pipe(Effect.provide(session)),
        );
        expect(resumed).toMatchObject({ activation: expect.any(Number) });
        expect(
          yield* Context.get(session, SessionRequests).decide(
            runId,
            pending!.requestId,
            { action: 'approve' },
          ),
        ).toBe(true);
        yield* untilStored(
          storage,
          () => rowsOf(storage, runId, 'tool.result').length > 0,
        );
        yield* closeTestSession(storage);

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
