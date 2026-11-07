/**
 * The evidence a real-model acceptance run writes (`acceptance.ts`): per
 * scenario, what its session holds about the run and the checks it made;
 * per run, `run.json` and a `summary.md`. The format is described in
 * `.agents/docs/evidence/2026-11-03-harness-real-model/README.md`.
 */
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Effect } from 'effect';
import type { ExportNode, LocalSession } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

import { scriptReturnsOf } from './_support.ts';

/** One named check and what it saw. */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** What one scenario leaves for its report. */
export interface ScenarioResult {
  readonly scenario: string;
  readonly passed: boolean;
  readonly reason: string | null;
  readonly runId: string | null;
  readonly checks: readonly Check[];
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runs: number;
  readonly scripts: number;
  readonly failedScripts: number;
  readonly seconds: number;
}

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const clip = (text: string, limit = 4000) =>
  text.length > limit
    ? `${text.slice(0, limit)}… [${text.length} chars]`
    : text;

/** The tool calls a run's trace records, each with how it ended. */
const callsOf = (session: LocalSession, runId: RunId) =>
  Effect.gen(function* () {
    const exported = yield* session.records(runId).readTrace();
    if (exported.status !== 'ok') return [];
    const ends = new Map<string, { status: string; result?: unknown }>();
    for (const event of exported.trace.events)
      if (event.type === 'tool.end') ends.set(event.logId, event);
    return exported.trace.events.flatMap((event) =>
      event.type === 'tool.start'
        ? [
            {
              id: event.logId,
              tool: event.toolName,
              input: event.input,
              status: ends.get(event.logId)?.status ?? 'open',
              result: ends.get(event.logId)?.result,
            },
          ]
        : [],
    );
  });

/** The code of every `script` call in a conversation, in order. */
const scriptsOf = (conversation: readonly ExportNode[]): string[] =>
  conversation.flatMap((node) =>
    node.kind === 'tool-call' &&
    node.name === 'script' &&
    typeof (node.input as { code?: unknown } | null)?.code === 'string'
      ? [(node.input as { code: string }).code]
      : [],
  );

/**
 * Writes what a scenario's session holds about its run under `dir`: the
 * run's config, every run's identity, outcome and spend, the scripts the
 * model wrote, each conversation, the trace's tool calls, the script
 * returns and final reply, and a copy of the session database.
 */
export const writeEvidence = (
  dir: string,
  session: LocalSession,
  runId: RunId,
  workspace: string,
) =>
  Effect.gen(function* () {
    const records = session.records(runId);
    const conversation = yield* records.readConversation();
    const runs = [...session.view.current().runs.values()];
    const children: Record<string, readonly ExportNode[]> = {};
    for (const run of runs)
      if (run.id !== runId)
        children[run.id] = yield* session.records(run.id).readConversation();
    const scripts = scriptsOf(conversation);
    const end = yield* records.readRunEnd();
    yield* Effect.promise(async () => {
      await mkdir(join(dir, 'scripts'), { recursive: true });
      await mkdir(join(dir, 'outputs'), { recursive: true });
      for (const [index, code] of scripts.entries())
        await writeFile(join(dir, 'scripts', `${index + 1}.js`), `${code}\n`);
      await writeFile(join(dir, 'conversation.json'), json(conversation));
      await writeFile(join(dir, 'children.json'), json(children));
      await writeFile(
        join(dir, 'runs.json'),
        json(
          runs.map((run) => ({
            id: run.id,
            parentId: run.parentId,
            identity: run.identity,
            model: run.model,
            position: run.position,
            outcome: run.outcome,
            usage: run.usage,
          })),
        ),
      );
      await writeFile(
        join(dir, 'outputs', 'script-returns.json'),
        json(scriptReturnsOf(conversation)),
      );
      await writeFile(join(dir, 'outputs', 'run-end.json'), json(end ?? null));
      await writeFile(
        join(dir, 'outputs', 'response.md'),
        `${end?.output.response ?? ''}\n`,
      );
    });
    const config = yield* records.readConfig();
    yield* Effect.promise(() =>
      writeFile(join(dir, 'config.json'), json(config)),
    );
    const calls = yield* callsOf(session, runId);
    yield* Effect.promise(async () => {
      await writeFile(
        join(dir, 'calls.json'),
        json(
          calls.map((call) => ({
            ...call,
            result:
              call.result === undefined
                ? undefined
                : clip(JSON.stringify(call.result)),
          })),
        ),
      );
      // The database, kept beside the text evidence and out of git.
      const storage = join(workspace, 'storage');
      await mkdir(join(dir, 'store'), { recursive: true });
      for (const entry of await readdir(storage, { recursive: true }))
        if (/texra\.db(-wal|-shm)?$/.test(entry))
          await copyFile(
            join(storage, entry),
            join(dir, 'store', entry.replaceAll('/', '__')),
          );
    });
    return { conversation, calls, scripts, runs, end };
  });

/** Sums what every run of the session spent. */
const spendOf = (session: LocalSession) =>
  [...session.view.current().runs.values()].reduce(
    (sum, run) => ({
      costUsd: sum.costUsd + run.usage.cost,
      inputTokens: sum.inputTokens + run.usage.inputTokens,
      outputTokens: sum.outputTokens + run.usage.outputTokens,
      runs: sum.runs + 1,
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, runs: 0 },
  );

/** Runs one scenario's program, writes its evidence, and states its result
 *  whatever happened, a thrown error included. */
export async function runScenario(
  out: string,
  name: string,
  body: (dir: string) => Promise<Omit<ScenarioResult, 'scenario' | 'seconds'>>,
): Promise<ScenarioResult> {
  const dir = join(out, name);
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  const result = await body(dir).catch(
    (error: unknown): Omit<ScenarioResult, 'scenario' | 'seconds'> => ({
      passed: false,
      reason: error instanceof Error ? error.message : String(error),
      runId: null,
      checks: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
      scripts: 0,
      failedScripts: 0,
    }),
  );
  const full = {
    scenario: name,
    ...result,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  await writeFile(join(dir, 'result.json'), json(full));
  console.log(
    `[acceptance] ${name}: ${full.passed ? 'pass' : `FAIL (${full.reason})`}`,
  );
  return full;
}

/** A scenario's result from its checks and its session's evidence. */
export const judged = (
  session: LocalSession,
  runId: RunId,
  checks: Check[],
  evidence: {
    readonly calls: readonly { tool: string; status: string }[];
    readonly scripts: readonly string[];
  },
) => {
  const failed = checks.filter((check) => !check.ok);
  return {
    passed: failed.length === 0,
    reason:
      failed.length === 0
        ? null
        : failed
            .map((check) => `${check.name}: ${check.detail ?? 'no'}`)
            .join('; '),
    runId,
    checks,
    ...spendOf(session),
    // A resumed script's card opens again under its call: count the calls
    // from the conversation, the failures from the cards.
    scripts: evidence.scripts.length,
    failedScripts: evidence.calls.filter(
      (call) => call.tool === 'script' && call.status === 'failed',
    ).length,
  };
};

export const check = (name: string, ok: boolean, detail?: unknown): Check => ({
  name,
  ok,
  ...(detail !== undefined && {
    detail:
      typeof detail === 'string' ? detail : clip(JSON.stringify(detail), 600),
  }),
});

/** What a whole run leaves: its route and every scenario's result. */
export interface RunReport {
  readonly route: string;
  readonly model: string;
  readonly started: string;
  readonly harness: string;
  readonly commit: string | null;
  readonly node: string;
  readonly runLimit: string;
  readonly skipped: string | null;
  readonly results: readonly ScenarioResult[];
}

/** Writes `run.json` and `summary.md` for a whole run under `out`. */
export async function writeReport(out: string, run: RunReport): Promise<void> {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'run.json'), json(run));
  const { results } = run;
  const total = results.reduce((sum, r) => sum + r.costUsd, 0);
  await writeFile(
    join(out, 'summary.md'),
    [
      `# ${run.model}, ${run.started.slice(0, 10)}`,
      '',
      `Harness ${run.harness} from the packed tarball${run.commit ? ` at \`${run.commit.slice(0, 10)}\`` : ''}, Node ${run.node}.`,
      run.skipped
        ? `Skipped: ${run.skipped}. Nothing was sent.`
        : `Spend reported by the runs: $${total.toFixed(4)}.`,
      '',
      '| Scenario | Result | Runs | Scripts (failed) | Tokens in/out | Cost (USD) | Seconds |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...results.map(
        (r) =>
          `| ${r.scenario} | ${r.passed ? 'pass' : 'fail'} | ${r.runs} | ${r.scripts} (${r.failedScripts}) | ${r.inputTokens}/${r.outputTokens} | ${r.costUsd.toFixed(4)} | ${r.seconds} |`,
      ),
      '',
      ...results.flatMap((r) => [
        `## ${r.scenario}`,
        '',
        ...(r.checks.length === 0 ? [`- error: ${r.reason}`] : []),
        ...r.checks.map(
          (c) =>
            `- ${c.ok ? 'pass' : 'FAIL'}: ${c.name}${c.ok || c.detail === undefined ? '' : ` (${c.detail.replaceAll('|', '/')})`}`,
        ),
        '',
      ]),
    ].join('\n'),
  );
}
