/**
 * Example 03 — Custom tools (`defineTool`) and plugins (`definePlugin`).
 *
 * Defines a typed tool with `defineTool` (using `nullishWithDefault` for
 * provider-compatible optional parameters), packages it into a `Plugin` with
 * `definePlugin`, and runs a two-turn agent loop where the model invokes the
 * tool on turn 1 and summarizes the tool output on turn 2.
 */
import { Effect, Schema } from 'effect';
import { defineTool, Sessions } from '@texra-ai/harness';
import {
  definePlugin,
  executed,
  harnessBuiltins,
  nullishWithDefault,
} from '@texra-ai/harness/plugins';

import { makeExampleWorkspace } from './_support.ts';

const countEquationsTool = defineTool({
  name: 'count_equations',
  description: 'Count display equations in a LaTeX snippet.',
  lane: 'parallel',
  replay: 'safe',
  schema: Schema.Struct({
    tex: Schema.String.annotate({ description: 'LaTeX source snippet.' }),
    includeUnnumbered: nullishWithDefault(
      Schema.Boolean,
      true,
      'Whether to count $$...$$ and \\[...\\] blocks.',
    ),
  }),
  execute: ({ tex, includeUnnumbered }) =>
    Effect.sync(() => {
      const numbered = [...tex.matchAll(/\\begin\{(equation|align|gather)\}/g)]
        .length;
      const unnumbered = includeUnnumbered
        ? [...tex.matchAll(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g)].length
        : 0;
      const total = numbered + unnumbered;
      return executed(
        JSON.stringify({ numbered, unnumbered, total }),
        `Counted ${total} equation(s)`,
      );
    }),
});

const latexMetricsPlugin = definePlugin({
  id: 'latex-metrics',
  tools: { count_equations: countEquationsTool },
});

const { platform, requests } = await makeExampleWorkspace([
  {
    toolCalls: [
      {
        id: 'call_eq_1',
        name: 'count_equations',
        input: {
          tex: '\\begin{equation}E = mc^2\\end{equation}\n$$a^2 + b^2 = c^2$$',
          includeUnnumbered: true,
        },
      },
    ],
  },
  {
    text: 'Found 2 display equations (1 numbered, 1 unnumbered).',
  },
]);

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);

  const run = yield* session.start({
    agent: {
      name: 'equation_auditor',
      description: 'Counts equations in LaTeX drafts.',
      prompt: 'Use count_equations to inspect the snippet.',
      tools: ['count_equations'],
    },
    instruction: 'Count the equations in section 1.',
    model: 'anthropic/claude-sonnet-5-5',
  });

  const end = yield* run.result;
  console.log(
    `[03] model turns=${requests.length} outcome=${end.outcome} reply="${end.output.response}"`,
  );
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: [...harnessBuiltins, latexMetricsPlugin],
    }),
  ),
);

await Effect.runPromise(program);
