/**
 * Example 06 — Reactive `SessionView`, view queries, and `TranscriptRow` formatting.
 *
 * 1. Writes a `paper.tex` file in the workspace and subscribes to the run's
 *    transcript via `session.view.subscribe`.
 * 2. Runs an agent that calls the built-in `read_file` tool on `paper.tex` and
 *    answers from its contents.
 * 3. Reads `SessionView` with `@texra-ai/harness/schemas` helpers
 *    (`sessionActivity`, `attentionOf`, `acceptsFollowUp`) and formats every
 *    `TranscriptRow` with `@texra-ai/harness/transcript` (`rowHeadline`,
 *    `elideText`).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Effect } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import {
  acceptsFollowUp,
  attentionOf,
  generateRunId,
  qualifyAggregateId,
  sessionActivity,
} from '@texra-ai/harness/schemas';
import { elideText, rowHeadline } from '@texra-ai/harness/transcript';

import { makeExampleWorkspace } from './_support.ts';

const { workspace, platform } = await makeExampleWorkspace([
  {
    toolCalls: [
      {
        id: 'call_read_1',
        name: 'read_file',
        input: { path: 'paper.tex' },
      },
    ],
  },
  {
    text: 'The title in paper.tex is "On Monotone Operators".',
  },
]);

await writeFile(
  join(workspace, 'paper.tex'),
  [
    '\\documentclass{article}',
    '\\title{On Monotone Operators}',
    '\\begin{document}',
    '\\maketitle',
    'We study monotone operators in Hilbert spaces.',
    '\\end{document}',
    '',
  ].join('\n'),
  'utf8',
);

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);

  const runId = generateRunId();
  yield* session.view.subscribe([
    { id: qualifyAggregateId('run', runId), fromSeq: 0 },
  ]);

  const run = yield* session.start({
    runId,
    agent: {
      name: 'reader',
      description: 'Reads LaTeX files.',
      prompt: 'Read paper.tex and report its title.',
      tools: ['read_file'],
    },
    instruction: 'What is the title in paper.tex?',
    model: 'anthropic/claude-sonnet-5-5',
  });

  yield* run.result;
  yield* session.settled;

  const view = session.view.current();
  const runView = view.runs.get(run.runId);
  if (!runView) throw new Error('Missing RunView after settlement.');

  console.log(
    `[06] activity=${sessionActivity(view)} attention=${attentionOf(view).requests.length} acceptsFollowUp=${acceptsFollowUp(runView)}`,
  );

  for (const row of runView.transcript.rows) {
    const headline = rowHeadline(row) ?? row.kind;
    if (row.kind === 'tool') {
      const sectionKinds = row.model.sections.map((s) => s.kind).join(',');
      console.log(
        `[06] row kind=tool headline="${headline}" status=${row.log.status} sections=[${sectionKinds}]`,
      );
    } else if (row.kind === 'assistant' || row.kind === 'user') {
      const elided = elideText(row.text, { headLines: 1, tailLines: 0 });
      console.log(
        `[06] row kind=${row.kind} headline="${headline}" firstLine="${elided.head[0] ?? ''}"`,
      );
    } else {
      console.log(`[06] row kind=${row.kind} headline="${headline}"`);
    }
  }
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);

await Effect.runPromise(program);
