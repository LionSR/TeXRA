/**
 * Example 07 — A programmed path: an agent file, a plugin tool, a script
 * module, `self()` twice and a SQL query over the run history.
 *
 * 1. Writes a flat persona YAML into the agent directory the platform serves
 *    and starts the run by the agent's name. The model sees the same system
 *    text and tools as for the equivalent inline persona.
 * 2. Offers a plugin tool (`definePlugin` + `defineTool`) beside
 *    `harnessBuiltins`, with a script module (`scriptModules`) over it.
 * 3. The model's first turn calls `script`. The program imports the module,
 *    calls the plugin tool through it, runs `self()` twice with a JSON
 *    Schema (each child submits a structured value) and reads the fields.
 * 4. The program then reads its own calls back with `executions` SQL: the
 *    plugin call's result (`tool_calls`: `columns`, `rows` and `more`, the
 *    structured value and a long text cell), each `self()` child's status
 *    (`runs`, joined to the call that launched it), and a write refused.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Effect, Layer, Schema } from 'effect';
import { defineTool, HISTORY_TABLES, Sessions } from '@texra-ai/harness';
import { definePlugin, harnessBuiltins } from '@texra-ai/harness/plugins';

import { makeExampleWorkspace, scriptReturnsOf } from './_support.ts';

/** A tool whose result carries a value a script reads directly, and an
 *  output long enough to need a long cell in the history store. */
const outlineTool = defineTool({
  name: 'outline_sections',
  description: 'List the section titles of a LaTeX snippet.',
  replay: 'safe',
  schema: Schema.Struct({ tex: Schema.String }),
  execute: ({ tex }) =>
    Effect.sync(() => {
      const titles = [...tex.matchAll(/\\section\{([^}]*)\}/g)].map(
        (match) => match[1] ?? '',
      );
      return {
        status: 'executed' as const,
        output: `${titles.join('\n')}\n${'.'.repeat(3000)}`,
        summary: `${titles.length} sections`,
        value: { titles },
      };
    }),
});

const latexPlugin = definePlugin({
  id: 'latex-outline',
  tools: [outlineTool],
  scriptModules: {
    latex: 'export const outline = (tex) => tools.outline_sections({ tex });',
  },
});

const PERSONA = {
  name: 'programmed_path',
  description: 'Outlines a draft and reviews it in two rounds.',
  prompt: 'Outline the draft with a script, then review it twice.',
  tools: ['script', 'executions', 'outline_sections'],
};
const TEX = '\\section{Setup}\\section{Main bound}';
/** Each `self()` child as `runs` and its launching call read it. */
const CHILDREN = 'ended:completed:executed,ended:completed:executed';
const VERDICT = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};
const CODE = `
const { outline } = await import('builtIn:latex');
const { titles } = await outline(${JSON.stringify(TEX)});
const schema = ${JSON.stringify(VERDICT)};
const first = await self('Round 1: check the setup.', { schema });
const second = await self('Round 2: check the bound.', { schema });
const sql = (sql, params = []) =>
  tools.executions({ path: '/executions', action: 'query', sql, params });
const page = await sql(
  "SELECT tool, status, value, output FROM tool_calls WHERE script_call_id = ? AND tool = 'outline_sections'",
  ['call_script'],
);
const children = await sql(
  'SELECT r.status, r.outcome, c.status FROM runs r JOIN tool_calls c ON c.position = r.parent_call_position WHERE c.script_call_id = ? ORDER BY c.position',
  ['call_script'],
);
let write = null;
try {
  await sql('WITH gone AS (SELECT 1) DELETE FROM tool_calls');
} catch (error) {
  write = error.message;
}
const [tool, status, value, output] = page.rows[0] ?? [];
return {
  titles,
  verdicts: [first.structured.verdict, second.structured.verdict],
  columns: page.columns,
  more: page.more,
  call: [tool, status, JSON.parse(value).titles.join()],
  longCell: output?.length ?? null,
  children: children.rows.map((row) => row.join(':')),
  write,
};`;

const { platform, agentsDir, requests, route } = await makeExampleWorkspace([
  { text: 'Inline persona reply.', expect: 'Inline start.' },
  {
    expect: 'Outline and review.',
    toolCalls: [{ id: 'call_script', name: 'script', input: { code: CODE } }],
  },
  {
    expect: 'Round 1:',
    toolCalls: [{ name: 'submit_output', input: { verdict: 'setup-ok' } }],
  },
  {
    expect: 'Round 2:',
    toolCalls: [{ name: 'submit_output', input: { verdict: 'bound-ok' } }],
  },
  { expect: 'The script returned', text: 'Both rounds passed.' },
]);
await writeFile(
  join(agentsDir, 'programmed-path.yaml'),
  [
    `name: ${PERSONA.name}`,
    `description: ${PERSONA.description}`,
    `prompt: ${PERSONA.prompt}`,
    `tools: [${PERSONA.tools.join(', ')}]`,
    '',
  ].join('\n'),
);

/** What a request tells the model: its system text and its tools' names. */
const shape = (request: Readonly<Record<string, unknown>> | undefined) =>
  JSON.stringify({
    system: request?.system,
    tools: (request?.tools as { name: string }[] | undefined)?.map(
      ({ name }) => name,
    ),
  });

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);
  const { model } = route;

  const inline = yield* session.start({
    agent: PERSONA,
    instruction: 'Inline start.',
    model,
  });
  yield* inline.result;

  const run = yield* session.start({
    agent: PERSONA.name,
    instruction: 'Outline and review.',
    model,
  });
  const end = yield* run.result;
  if (end.outcome !== 'completed')
    throw new Error(`run ended ${end.outcome}: ${JSON.stringify(end)}`);

  // 1. The run named a file agent, and the model was told and offered
  // exactly what the inline persona gets.
  const config = yield* session.records(run.runId).readConfig();
  const fromFile = shape(requests[1]);
  if (config?.agent !== PERSONA.name || fromFile !== shape(requests[0]))
    throw new Error(`file persona differs from inline: ${fromFile}`);
  console.log(`[07] agent file ${config.agent} = inline persona`);

  // 2-4. What the script returned, read back from the stored conversation.
  // The script's return is its result node's structured `value`.
  const conversation = yield* session.records(run.runId).readConversation();
  const returned = scriptReturnsOf(conversation).at(-1) as {
    titles: string[];
    verdicts: string[];
    columns: string[];
    more: boolean;
    call: string[];
    longCell: number;
    children: string[];
    write: string | null;
  };
  const expected = ['setup-ok', 'bound-ok'];
  if (
    returned.titles.join() !== 'Setup,Main bound' ||
    returned.verdicts.join() !== expected.join() ||
    returned.columns.join() !== 'tool,status,value,output' ||
    !returned.columns.every((column) =>
      HISTORY_TABLES.tool_calls.some((name) => name === column),
    ) ||
    returned.more !== false ||
    returned.call.join('|') !== 'outline_sections|executed|Setup,Main bound' ||
    !(returned.longCell > 3000) ||
    returned.children.join() !== CHILDREN ||
    !returned.write?.includes('readonly')
  )
    throw new Error(`unexpected script return: ${JSON.stringify(returned)}`);
  console.log(
    `[07] script: titles=${returned.titles.join('|')} verdicts=${returned.verdicts.join('|')} query columns=${returned.columns.join('|')} more=${returned.more} call=${returned.call.join('|')} long cell=${returned.longCell} chars children=${returned.children.join('|')} write refused`,
  );
  console.log(
    `[07] model turns=${requests.length} reply="${end.output.response}"`,
  );
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: [...harnessBuiltins, latexPlugin],
    }).pipe(Layer.provideMerge(route.transport)),
  ),
);

await Effect.runPromise(program);
