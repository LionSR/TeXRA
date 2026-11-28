/**
 * The deterministic model the package-validation gate runs against, and the
 * gate that selects it. Package validation (`TEXRA_CLI_INCLUDE_INTERNAL_
 * VALIDATION_MODEL=1`) swaps the provider models for this canned llm `Model`
 * at the provider boundary, so a `texra run` smoke test exercises the real
 * CLI and `executeAgent` path without a live model API.
 *
 * Only that build carries this module: a shipped CLI bundle loads a stub in
 * its place (`scripts/stub-internal-validation-model.mjs`). The bundle's
 * switches (`validationSwitch.ts`) go through the ambient `ConfigProvider`
 * (`envVar`), read when the program runs; an in-process caller hands
 * {@link validationModel} its scenario as a value.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { Effect, Layer, Schedule, Stream } from 'effect';
import {
  type Model,
  type ModelConfig,
  ModelError,
  type ModelOrigin,
  originOf,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from '@texra-ai/llm';
import { ValidationModel } from '@texra-ai/worldline/host';
import { envVar } from '@texra-ai/worldline/node';

// Local imports - component
import {
  VALIDATION_FLAG as FLAG,
  VALIDATION_FLAG_CONTENT as FLAG_CONTENT,
  VALIDATION_SCENARIOS,
  VALIDATION_SWITCH as SWITCH,
} from './validationSwitch';
import { GOLDEN_AGENTS } from './validationAgents';

/** Which scripted conversations the model plays, as a turn reads them. */
interface ValidationScenario {
  readonly scriptFanout: boolean;
  readonly historyQuery: boolean;
  readonly echo: boolean;
  /** The golden store's conversation, whose held calls wait for their
   *  `*.release` files in this directory; null when off. */
  readonly golden: string | null;
}
// The harness's words for a compaction request and a call that never ran.
const COMPACTION_SYSTEM_PROMPT_START = 'Summarize the conversation below.';
const SKIPPED_NOT_STARTED = 'interrupted before the Harness recorded it';

const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model.
`;

/** The golden child as a call writes it: its system text, tools and name. */
const GOLDEN_CHILD = Object.freeze({
  system: GOLDEN_AGENTS.golden_child.system,
  tools: GOLDEN_AGENTS.golden_child.tools,
  label: GOLDEN_AGENTS.golden_child.label,
});
/** The same, as a script's `agent()` options write it (it names its own
 *  label). */
const GOLDEN_CHILD_OPTIONS = `system: ${JSON.stringify(GOLDEN_CHILD.system)}, tools: ${JSON.stringify(GOLDEN_CHILD.tools)}`;

/** The validation fan-out: three structured `agent()` calls under one
 *  `Promise.allSettled`, each to a child the script writes, answered
 *  by the call's schema. */
const SCRIPT_FANOUT_VALIDATION_SOURCE = `const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'derivation', 'check'],
  properties: {
    answer: { type: 'string' },
    derivation: { type: 'string' },
    check: { type: 'string' },
  },
}
section('Solve')
const results = await Promise.allSettled([
  agent('Find all integer solutions to x^2 - y^2 = 45.', { id: 'number-theory', system: 'Solve the problem and check the answer.', label: 'Solve the Diophantine equation', schema }),
  agent('Classify a real 3 by 3 matrix with A^2 = A and trace(A) = 2.', { id: 'linear-algebra', system: 'Solve the problem and check the answer.', label: 'Classify the matrix', schema }),
  agent('Compute whether HHT or THH appears first for a fair coin.', { id: 'probability', system: 'Solve the problem and check the answer.', label: 'Compute the stopping probability', schema }),
])
return { solutions: results.map((result) => result.status === 'fulfilled' ? result.value.structured : null) }`;

/** The golden store's script: finds the reading tool, a read and then a
 *  command, then a child it writes (`system`, `tools`). The calls run one after
 *  the other so their rows commit in one order and every generation of the
 *  store is the same; concurrent calls are the crash run's script. */
const GOLDEN_SCRIPT_SOURCE = `section('Gather')
const [found] = await searchTools('read a file', { limit: 1 })
const declaration = await describeTool(found.name)
const notes = await tools[found.name]({ path: 'notes.tex' })
const shell = await tools.bash({ command: 'echo gathered', description: 'Say gathered' })
return { found: found.name, documented: declaration.includes('path: string'), notes: notes.output, shell: shell.output, defined: (await agent('Answer from the notes.', { label: 'Defined agent', system: 'GOLDEN-CHILD: answer the task.', tools: ['read_file', 'executions'] })).response }`;

/** The crash suite's background script: one awaited `agent()` call, whose
 *  child the background script run owns. */
const GOLDEN_BACKGROUND_SOURCE = `section('Deliver')
const child = await agent('Background child: answer.', { ${GOLDEN_CHILD_OPTIONS}, label: 'Child' })
return { delivered: child.response }`;

/** The crash-point conformance run's script: a read and a command in one
 *  `Promise.all`, then an awaited `agent()` call, whose child the call owns
 *  (`run.start.parent.call`). */
const GOLDEN_CRASH_SOURCE = `section('Gather')
const [notes, shell] = await Promise.all([
  tools.read_file({ path: 'notes.tex' }),
  tools.bash({ command: 'echo script >> effects.log', description: 'Record the script effect' }),
])
const child = await agent('Answer the conformance child task.', { ${GOLDEN_CHILD_OPTIONS}, label: 'Child' })
return { notes: notes.output, shell: shell.output, child: child.response }`;

/** The limits run's script: a `self()` child held to a spend cap its first
 *  reply passes, then a fork of the conversation on a model the call names,
 *  under a cap it never reaches. */
const GOLDEN_LIMITS_SOURCE = `section('Limits')
let capped
try {
  await self('Spend past the cap, then hold.', { fork: false, label: 'Capped', maxCostUsd: 1e-9 })
  capped = 'finished'
} catch (error) {
  capped = error.name
}
const named = await self('Answer on the named model.', { label: 'Named', model: 'openai/gpt-6.1-sol', maxCostUsd: 100 })
return { capped, named: named.response }`;

/** The resources run's script: what the run's resources are, then what a
 *  child under a spend cap says of its own. */
const GOLDEN_RESOURCES_SOURCE = `const own = await tools.resources({})
const child = await self('Read your resources.', { fork: false, label: 'Capped', maxCostUsd: 100 })
return { own, child: child.response }`;

/** The program the own-program run writes for itself: it asks a child and
 *  returns what the child said. */
const GOLDEN_OWN_PROGRAM = `// Asks a child and reports its answer.
export const description = 'Ask a child and report its answer.';
export const uses = ['read_file', 'agent'];

export default async () => {
  const child = await agent('Own child: answer.', { ${GOLDEN_CHILD_OPTIONS}, label: 'Own child' });
  return 'own program ran; child said: ' + child.response;
};
`;

/** The crash-point run's last script: it finds the edit's call and result
 *  in its view and replaces the two with its own note, which the run
 *  applies at its next request. */
const GOLDEN_CRASH_TRIM_SOURCE = `section('Trim')
const view = await tools.context({})
const at = view.messages.findIndex((message) => message.preview.startsWith('edit_file('))
await tools.context({ action: 'replace', from: at, to: at + 2, with: 'Edited notes.tex: it now edits this file.' })
return 'trimmed'`;

/** What an agent's replacement opens with in its view. */
const REPLACED_MARKER = '[Context you replaced]';

/** A reply's content. */
type Reply = TurnResult['content'];

/** A reply of `value` alone. */
const text = (value: string): Reply => [
  { kind: 'message', content: [{ kind: 'text', text: value }] },
];

/** What the golden chat's goal round reports, and its result carries. */
const ANSWERED = 'The golden chat is answered.';

/** A golden turn as its scenario reads it. */
interface GoldenTurn {
  readonly turn: ResolvedTurn;
  readonly system: string;
  /** The conversation as JSON, which a scenario searches for its cues. */
  readonly said: string;
  /** The tool results so far: a scenario's step is their count. */
  readonly results: ReadonlyArray<
    Extract<ResolvedTurn['messages'][number], { readonly role: 'tool' }>
  >;
  readonly call: (name: string, input: unknown) => Reply[number];
  /** Waits until the release file `name` exists. */
  readonly gate: (name: string) => Effect.Effect<void>;
}

/** The reply at the step the tool results count to, then `done`. */
const stepped = (
  { results }: GoldenTurn,
  steps: ReadonlyArray<() => Reply>,
  done: Reply,
): Reply => steps[results.length]?.() ?? done;

/** A call awaiting approval: the tool after the marker, and its command,
 *  or its whole input when a JSON object follows the tool. */
function approval({ system, results, call }: GoldenTurn) {
  const [, asked = 'bash', command = 'echo approved >> approved.txt'] =
    /GOLDEN-APPROVAL(?: (\w+))?(?: (.+))?/.exec(system) ?? [];
  const input: unknown = command.startsWith('{')
    ? JSON.parse(command)
    : { command };
  return Effect.succeed(
    results.length ? text('The approved command ran.') : [call(asked, input)],
  );
}

/** A diagnostics read the service forwards to an attached window. */
const diagnostics = ({ results, call }: GoldenTurn) =>
  Effect.succeed(
    results.length === 0
      ? [call('diagnostics', { command: 'list', path: 'main.tex' })]
      : text('The diagnostics read came back.'),
  );

/** The golden parent's child: it looks its parent up and messages it. */
function child({ said, results, call }: GoldenTurn) {
  // Messaging its waiting headless parent is refused (it never reads).
  if (!said.includes('Answer the delegated child task'))
    return Effect.succeed(text('Child result.'));
  if (results.length === 0)
    return Effect.succeed([
      call('executions', {
        path: '/executions',
        action: 'query',
        sql: "SELECT id FROM runs WHERE name = 'golden_parent'",
      }),
    ]);
  const page = results[0]?.results
    .flatMap((result) => result.content)
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('\n');
  const parent = /^([0-9a-f]{12})$/m.exec(page ?? '')?.[1];
  return Effect.succeed(
    results.length === 1 && parent !== undefined
      ? [
          call('executions', {
            path: `/executions/${parent}`,
            action: 'send',
            message: 'The delegated child has a note for its parent.',
          }),
        ]
      : text('Child result.'),
  );
}

/** The interactive chat: a plan run as a goal, its round and result, and
 *  replies after a `/model` and a `/compact`, told apart by what they say. */
function chat({ turn, said, results, call, gate }: GoldenTurn) {
  // A Codex child held until a stop; what is typed behind stays queued.
  if (said.includes('Hold this turn.'))
    return results.length === 0
      ? Effect.succeed([call('codex', { prompt: 'Answer the Codex task.' })])
      : gate('golden-chat.release').pipe(Effect.as(text('Released.')));
  if (said.includes('The golden chat so far.'))
    return Effect.succeed(text('Answered after the compaction.'));
  // The judge of the round's `done` (a fresh `self()`): its claims.
  if (said.includes('<goal_judge>'))
    return Effect.succeed([
      call('submit_output', {
        claims: [
          {
            requirement: 'The golden chat is answered.',
            status: 'verified',
            check: 'Read the round report.',
            observed: ANSWERED,
          },
        ],
      }),
    ]);
  // The goal's round (`self()`): a command its grant approves, a verdict.
  // Its first call is held, so the chat that started the goal finishes
  // its turn before the round goes on.
  const round = turn.tools.some(({ name }) => name === 'submit_output');
  const step = round
    ? [
        call('bash', { command: 'echo goal round', description: 'Goal' }),
        call('submit_output', { status: 'done', report: ANSWERED }),
      ]
    : [call('plan', { objective: 'Answer the golden chat, then stop.' })];
  const next = step.slice(results.length, results.length + 1);
  if (round && results.length === 0)
    return gate('golden-round.release').pipe(Effect.as(next));
  if (round || results.length === 0) return Effect.succeed(next);
  if (said.includes('After the model switch.'))
    return Effect.succeed(text('Answered after the model switch.'));
  return Effect.succeed(
    text(
      said.includes(ANSWERED)
        ? 'Golden chat goal complete.'
        : 'The plan runs as a goal.',
    ),
  );
}

/** The golden script run, and its background command. */
function script({ turn, said, results, call }: GoldenTurn) {
  // A background command waiting for its release file; its result wakes
  // the task once more. The wait is Node's, not a shell loop: the bash
  // tool runs a command in cmd.exe on Windows, which has no `until`.
  if (said.includes('Run in the background.')) {
    // A plugin's prompt section may change between the launch and the first
    // step (its probe answering), which appends a system message.
    const last = turn.messages.findLast(({ role }) => role !== 'system');
    if (last?.role === 'tool')
      return Effect.succeed(text('Sent to the background.'));
    return Effect.succeed(
      JSON.stringify(last).includes('Run in the background.')
        ? [
            call('bash', {
              command: `node -e "const wait = setInterval(() => { if (require('fs').existsSync('../bash.release')) { clearInterval(wait); console.log('released'); } }, 50)"`,
              description: 'Wait for the release',
              run_in_background: true,
            }),
          ]
        : text('The background command finished.'),
    );
  }
  return Effect.succeed(
    results.length === 0
      ? [
          call('script', {
            title: 'Gather the notes',
            code: GOLDEN_SCRIPT_SOURCE,
          }),
        ]
      : text('Script done.'),
  );
}

/** The fork: each reply names its view's user messages by their last
 *  lines, so the store records what the edit left. */
function fork({ turn }: GoldenTurn) {
  const users = turn.messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) =>
          part.kind === 'text' ? [part.text.trim().split('\n').at(-1)] : [],
        )
      : [],
  );
  return Effect.succeed(text(`Saw: ${users.join(' | ')}`));
}

/** The crash suite's delivery run: three children, each reporting back. */
const delivery = ({ results, call }: GoldenTurn) =>
  Effect.succeed(
    results.length === 0
      ? [
          call('agent', {
            ...GOLDEN_CHILD,
            prompt: 'Delivery child: answer.',
            background: true,
          }),
          call('script', {
            title: 'Deliver',
            code: GOLDEN_BACKGROUND_SOURCE,
            run_in_background: true,
          }),
          call('bash', {
            command: 'echo delivered',
            description: 'Deliver',
            run_in_background: true,
          }),
        ]
      : text('Noted.'),
  );

/** The crash-point run: two calls, an edit of the file they read, a script,
 *  a script that replaces the edit's call and result in its view, the
 *  echo's text. A step a crash cut off unstarted is asked for again; a
 *  view an edit replaced no longer holds the task (or holds the run's own
 *  replacement), and the echo shows the view the edit left. */
function crash({ said, results, call }: GoldenTurn) {
  const done = results.filter(
    (message) =>
      !message.results.some((result) =>
        result.content.some(
          (part) =>
            part.kind === 'text' && part.text.includes(SKIPPED_NOT_STARTED),
        ),
      ),
  ).length;
  const step = [
    () => [
      call('read_file', { path: 'notes.tex' }),
      call('bash', {
        command: 'echo batch >> effects.log',
        description: 'Record the batch effect',
      }),
    ],
    // The file the first step read, edited in the next response.
    () => [
      call('edit_file', {
        path: 'notes.tex',
        old_str: 'reads this file',
        new_str: 'edits this file',
      }),
    ],
    () => [call('script', { title: 'Gather', code: GOLDEN_CRASH_SOURCE })],
    () => [call('script', { title: 'Trim', code: GOLDEN_CRASH_TRIM_SOURCE })],
  ][done];
  return Effect.succeed(
    step === undefined ||
      !said.includes('Work through the crash task.') ||
      said.includes(REPLACED_MARKER)
      ? null
      : step(),
  );
}

/** The limits run: its script's `self()` children, told apart by their
 *  tasks. One spends (a priced reply that calls a tool) and then is never
 *  answered, so only its call's cap ends it; the other answers at once. */
function limits({ said, results, call }: GoldenTurn) {
  if (!said.includes('started this run of you with self()'))
    return Effect.succeed(
      results.length === 0
        ? [call('script', { title: 'Limits', code: GOLDEN_LIMITS_SOURCE })]
        : text('Limits done.'),
    );
  if (!said.includes('Spend past the cap, then hold.'))
    return Effect.succeed(text('Named model answered.'));
  return results.length === 0
    ? Effect.succeed([call('executions', { path: '/executions' })])
    : Effect.never;
}

/** The own-program run: it writes itself a program into the project
 *  memory folder its system text names, then its next step's script starts
 *  that program by name. */
function ownProgram(t: GoldenTurn) {
  const { system, call } = t;
  const folder = /^\s*(.+): Project memory: /m.exec(system)?.[1];
  return Effect.succeed(
    stepped(
      t,
      [
        () => [
          call('write_file', {
            path: `${folder}/programs/greet.js`,
            content: GOLDEN_OWN_PROGRAM,
          }),
        ],
        () => [
          call('script', {
            title: 'Start the program',
            code: "return (await program('own:greet')).response",
          }),
        ],
      ],
      text('Own program done.'),
    ),
  );
}

/** The wake run: it arranges to be continued in an hour and, when its
 *  task says so, cancels that by the id the call answered. Every reply
 *  counts the notes to itself the conversation holds by then. */
function wake(t: GoldenTurn) {
  const { said, call } = t;
  const id = /Its id is ([0-9a-f-]{36})/.exec(said)?.[1];
  return Effect.succeed(
    stepped(
      t,
      [
        () => [call('wake', { afterSeconds: 3600, note: 'Check the build.' })],
        ...(said.includes('then cancel it') && id !== undefined
          ? [() => [call('wake', { command: 'cancel', id })]]
          : []),
      ],
      text(`Notes read: ${said.split('<wake-note ').length - 1}`),
    ),
  );
}

/** The native plugin run: it installs and enables the plugin its task
 *  names, calls the tools its task names in turn, then calls its
 *  `native_echo` once, or two or three times with all but the last
 *  waiting for their release (three times with a listing of the plugins
 *  after the first). A step that does not offer `native_echo` says so,
 *  with what it does offer. */
function nativePlugin(t: GoldenTurn) {
  const { turn, said, results, call } = t;
  const offered = turn.tools.map(({ name }) => name);
  const source = /Install the plugin at (\S+?)\. /.exec(said)?.[1];
  const echo = (input: object) => () =>
    offered.includes('native_echo')
      ? [call('native_echo', input)]
      : text(`native_echo is not offered; offered: ${offered.join(', ')}`);
  // A plugin a person trusted and then disabled, enabled again.
  if (said.includes('Enable echoes again.'))
    return Effect.succeed(
      results.length === 0
        ? [call('plugin_manager', { command: 'enable', name: 'echoes' })]
        : text('Enabled again.'),
    );
  // `Call native_a, native_b in turn.`: each named tool once, offered or
  // not, then the echo.
  const named =
    /Call (native_\w+(?:, native_\w+)*) in turn\./.exec(said)?.[1] ?? null;
  return Effect.succeed(
    stepped(
      t,
      [
        () =>
          offered.includes('native_echo')
            ? [call('native_echo', {})]
            : [call('plugin_manager', { command: 'install', source })],
        () => [call('plugin_manager', { command: 'enable', name: 'echoes' })],
        ...(named === null
          ? []
          : named.split(', ').map((name) => () => [call(name, {})])),
        ...(said.includes('Echo, then echo waiting, in one reply.')
          ? [
              // Two calls of one tool in one reply, each its own id.
              () =>
                [
                  call('native_echo', {}),
                  call('native_echo', { wait: '1' }),
                ].map((each, n) =>
                  each.kind === 'local-call'
                    ? { ...each, providerCallId: `${each.providerCallId}-${n}` }
                    : each,
                ),
              echo({}),
            ]
          : said.includes('Echo twice, the first waiting.')
            ? [echo({ wait: '1' }), echo({})]
            : said.includes('Echo three times, the first two waiting.')
              ? [
                  echo({ wait: '1' }),
                  () => [call('plugin_manager', { command: 'list' })],
                  echo({ wait: '2' }),
                  echo({}),
                ]
              : [echo({})]),
      ],
      text('Echoed.'),
    ),
  );
}

/** The resources run: its script reads the run's resources, then those of
 *  a `self()` child held to a spend cap, which reads them directly and
 *  answers with the cap line they named. */
function resources({ said, results, call }: GoldenTurn) {
  if (said.includes('started this run of you with self()'))
    return Effect.succeed(
      results.length === 0
        ? [call('resources', {})]
        : text(/Spend cap: [^"\\]+/.exec(said)?.[0] ?? 'No cap named.'),
    );
  return Effect.succeed(
    results.length === 0
      ? [
          call('script', {
            title: 'Resources',
            code: GOLDEN_RESOURCES_SOURCE,
          }),
        ]
      : text('Resources read.'),
  );
}

/** The golden parent: a read, a plan, then a child. */
const parent = (t: GoldenTurn) =>
  Effect.succeed(
    stepped(
      t,
      [
        () => [t.call('read_file', { path: 'notes.tex' })],
        () => [
          t.call('plan', { objective: 'Read the notes and ask a child.' }),
        ],
        () => [
          t.call('agent', {
            ...GOLDEN_CHILD,
            prompt: 'Answer the delegated child task.',
          }),
        ],
      ],
      text('Parent done.'),
    ),
  );

/** The golden scenarios by the marker their system text carries. The first
 *  marker the system text holds picks the scenario, so a system text naming
 *  two plays the one listed first. */
const GOLDEN_SCENARIOS: ReadonlyArray<{
  readonly marker: string;
  readonly play: (turn: GoldenTurn) => Effect.Effect<Reply | null>;
}> = [
  { marker: 'GOLDEN-APPROVAL', play: approval },
  { marker: 'GOLDEN-DIAGNOSTICS', play: diagnostics },
  { marker: 'GOLDEN-CHILD', play: child },
  { marker: 'GOLDEN-CHAT', play: chat },
  { marker: 'GOLDEN-SCRIPT', play: script },
  { marker: 'GOLDEN-FORK', play: fork },
  { marker: 'GOLDEN-DELIVERY', play: delivery },
  { marker: 'GOLDEN-CRASH', play: crash },
  { marker: 'GOLDEN-LIMITS', play: limits },
  { marker: 'GOLDEN-OWN', play: ownProgram },
  { marker: 'GOLDEN-WAKE', play: wake },
  { marker: 'GOLDEN-NATIVE', play: nativePlugin },
  { marker: 'GOLDEN-RESOURCES', play: resources },
  { marker: 'GOLDEN-PARENT', play: parent },
];

/**
 * The golden 1.0 store's scripted conversation (`generate-golden-store.mjs`):
 * a system prompt names its scenario (`GOLDEN_SCENARIOS`), a step is its
 * count of tool results, and a held call waits for its `*.release` file in
 * `releases`. Null when no scenario answers the turn.
 */
function goldenTurn(
  turn: ResolvedTurn,
  releases: string,
  call: GoldenTurn['call'],
): Effect.Effect<Reply | null, ModelError> {
  const system = turn.system ?? '';
  const said = JSON.stringify(turn.messages);
  // A turn the provider refuses as too long for the model.
  if (system.includes('GOLDEN-OVERFLOW'))
    return Effect.fail(
      new ModelError({
        kind: 'context-overflow',
        message: 'The request exceeds the context window.',
        status: 400,
      }),
    );
  // The golden chat's `/compact`: its summary replaces the history.
  if (system.startsWith(COMPACTION_SYSTEM_PROMPT_START))
    return Effect.succeed(text('The golden chat so far.'));
  // The golden parent's session label: its `run.description`.
  if (
    system.startsWith('Generate a short session label') &&
    said.includes('<agent>golden_parent</agent>')
  )
    return Effect.succeed(text('Working through the golden parent task'));
  const gate = (name: string) => {
    const file = path.join(releases, name);
    return Effect.sync(() => existsSync(file)).pipe(
      Effect.repeat({ until: Boolean, schedule: Schedule.spaced('20 millis') }),
      Effect.asVoid,
    );
  };
  // A call naming GOLDEN-PARK (a label's too) waits for its release file.
  if ((system + said).includes('GOLDEN-PARK'))
    return Effect.as(gate('golden-park.release'), text('Parked run released.'));
  const scenario = GOLDEN_SCENARIOS.find(({ marker }) =>
    system.includes(marker),
  );
  if (scenario === undefined) return Effect.succeed(null);
  const results = turn.messages.filter((m) => m.role === 'tool');
  return scenario.play({ turn, system, said, results, call, gate });
}

function mathematicalValidationOutput(prompt: string): {
  answer: string;
  derivation: string;
  check: string;
} {
  if (prompt.includes('x^2 - y^2')) {
    return {
      answer:
        '(x,y) = (±23,±22), (±9,±6), and (±7,±2), with independent signs.',
      derivation:
        'Factor (x-y)(x+y)=45. The integer factor pairs of 45 with equal parity are (±1,±45), (±3,±15), and (±5,±9), including reversed signs. Solving x=(a+b)/2 and y=(b-a)/2 gives exactly the listed solutions.',
      check:
        'The factorization is bijective because x-y and x+y are odd divisors of 45; direct substitution gives differences of squares 45.',
    };
  }
  if (prompt.includes('A^2 = A')) {
    return {
      answer: 'A is similar over R to diag(1,1,0), and det(I+A)=4.',
      derivation:
        'The minimal polynomial divides t(t-1), whose roots are distinct, so A is diagonalizable with eigenvalues 0 and 1. The trace is the multiplicity of 1, hence it is 2.',
      check: 'I+A is similar to diag(2,2,1), whose determinant is 4.',
    };
  }
  return {
    answer: 'The probability that HHT appears before THH is 1/4.',
    derivation:
      'Track the longest suffix that is a prefix of either target: empty, H, HH, T, and TH. First-step recursion gives p_empty=(p_H+p_T)/2, p_H=(p_HH+p_T)/2, p_HH=(p_HH+1)/2, p_T=(p_TH+p_T)/2, and p_TH=p_T/2. Hence p_HH=1, p_T=p_TH=0, p_H=1/2, and p_empty=1/4.',
    check:
      'Substitution satisfies every state equation and uses absorbing values 1 after HHT and 0 after THH.',
  };
}

/** A turn no golden scenario answers: the echo, the script fan-out, the
 *  history query, or else the canned document. */
function cannedTurn(
  turn: ResolvedTurn,
  { scriptFanout, historyQuery, echo }: ValidationScenario,
  call: GoldenTurn['call'],
): Reply {
  const toolNames = new Set(turn.tools.map((tool) => tool.name));
  const hasToolResult = turn.messages.some(
    (message) => message.role === 'tool',
  );
  if (echo && turn.system?.startsWith(COMPACTION_SYSTEM_PROMPT_START))
    return text('Earlier turns, summarized.');
  if (echo) {
    // The user messages the request carries, in order, each by its last
    // 60 characters: what a fork or a compaction left of the model's view.
    const seen = turn.messages.flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((part) =>
            part.kind === 'text' ? [part.text.slice(-60)] : [],
          )
        : [],
    );
    return text(`Model saw: ${seen.join(' | ')}`);
  }
  if (scriptFanout && toolNames.has('submit_output'))
    return [
      call(
        'submit_output',
        mathematicalValidationOutput(JSON.stringify(turn.messages)),
      ),
    ];
  if (scriptFanout && !hasToolResult && toolNames.has('script'))
    return [
      call('script', {
        title: 'Solve the validation problems',
        code: SCRIPT_FANOUT_VALIDATION_SOURCE,
      }),
    ];
  if (historyQuery && !hasToolResult && toolNames.has('executions'))
    return [
      call('executions', {
        path: '/executions',
        action: 'query',
        sql: 'SELECT name, kind, status FROM runs ORDER BY started_at',
      }),
    ];
  if ((scriptFanout && toolNames.has('script')) || historyQuery) {
    // Hand the result back verbatim, so the run's report shows what the
    // script's children answered or what the query returned.
    const results = turn.messages.flatMap((message) =>
      message.role === 'tool' ? message.results : [],
    );
    const what = scriptFanout ? 'Script' : 'History query';
    return text(`${what} result: ${JSON.stringify(results)}`);
  }
  return text(VALIDATION_OUTPUT);
}

/**
 * True only inside a guarded package-validation run: the per-run switch is
 * `1`, and an absolute flag file holds the expected sentinel. `CI` is not read, so an interactive
 * `texra chat` (which a CI marker would force headless) can run against the
 * scripted model. Any partial/forged activation dies rather than silently
 * falling through to real models.
 */
const shouldUseInternalValidationModel = Effect.gen(function* () {
  if ((yield* envVar(SWITCH)) !== '1') return false;

  const flagPath = yield* envVar(FLAG);
  if (!flagPath || !path.isAbsolute(flagPath)) {
    return yield* Effect.die(
      new Error(
        `${SWITCH}=1 is restricted to package validation and needs an absolute ${FLAG} path.`,
      ),
    );
  }

  // An unreadable flag file dies with the filesystem error, which names it.
  const flagContent = readFileSync(flagPath, 'utf8');
  if (flagContent.trim() !== FLAG_CONTENT) {
    return yield* Effect.die(
      new Error(`${SWITCH}=1 received an invalid validation flag file.`),
    );
  }

  return true;
});

const VALIDATION_ENDPOINT = 'https://validation.invalid/v1';

/** The scenario the bundle's switches select, read per turn so a run's
 *  environment decides it; the golden releases go beside the flag file. */
const scenarioFromEnv: Effect.Effect<ValidationScenario> = Effect.gen(
  function* () {
    const on = (name: string) => Effect.map(envVar(name), (v) => v === '1');
    const flagPath = yield* envVar(FLAG);
    return {
      scriptFanout: yield* on(VALIDATION_SCENARIOS.scriptFanout),
      historyQuery: yield* on(VALIDATION_SCENARIOS.historyQuery),
      echo: yield* on(VALIDATION_SCENARIOS.echo),
      golden:
        (yield* on(VALIDATION_SCENARIOS.golden)) && flagPath
          ? path.dirname(flagPath)
          : null,
    };
  },
);

/** The canned llm `Model` behind the validation backend, playing the
 *  scenario `scenario` gives at each turn. */
export const validationModel =
  (scenario: Effect.Effect<ValidationScenario>) =>
  (
    config: ModelConfig,
  ): {
    readonly model: Model;
    readonly origin: ModelOrigin;
  } => {
    const origin = originOf({
      protocol: 'openai-responses',
      requestedModel: config.id,
      deployment: {
        endpoint: VALIDATION_ENDPOINT,
        credentialScope: 'validation',
      },
    });
    let responses = 0;
    const call = (name: string, input: unknown) =>
      ({
        kind: 'local-call',
        providerCallId: `validation-${name}-${responses}`,
        name,
        argumentsText: JSON.stringify(input),
      }) as const;
    const prepareTurn: Model['prepareTurn'] = (request) =>
      Effect.succeed({
        ...origin,
        mode: 'foreground',
        system: request.system,
        messages: request.messages,
        tools: request.tools ?? [],
        controls: {
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
          store: false,
          toolChoice: request.toolChoice ?? 'auto',
          reasoning: null,
          serviceTier: null,
          ...(request.cacheKey === undefined
            ? {}
            : { promptCacheKey: request.cacheKey }),
        },
      });
    const streamTurn: Model['streamTurn'] = (turn) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          responses += 1;
          const played = yield* scenario;
          const content =
            (played.golden === null
              ? null
              : yield* goldenTurn(turn, played.golden, call)) ??
            cannedTurn(turn, played, call);
          const calls = content.some((part) => part.kind === 'local-call');
          // About four characters a token, so compaction can be crossed.
          const inputTokens = played.echo
            ? Math.ceil(JSON.stringify(turn.messages).length / 4)
            : 1;
          return {
            providerResponseId: `validation-response-${responses}`,
            requestedOrigin: origin,
            returnedModel: config.id,
            content,
            finishReason: calls ? 'tool-calls' : 'stop',
            usage: {
              inputTokens,
              outputTokens: 1,
              totalTokens: inputTokens + 1,
              cachedInputTokens: null,
              cacheWriteTokens: null,
              reasoningTokens: null,
              toolUsePromptTokens: null,
            },
          } satisfies TurnResult;
        }),
      ).pipe(
        Stream.map((result): TurnEvent => ({ kind: 'completed', result })),
      );
    return { origin, model: { prepareTurn, streamTurn } };
  };

/** The harness's `ValidationModel` in the validation bundle: the canned
 *  model and its gate, both over the bundle's switches. */
export const validationModelLayer = Layer.succeed(ValidationModel)({
  enabled: shouldUseInternalValidationModel,
  bind: validationModel(scenarioFromEnv),
});
