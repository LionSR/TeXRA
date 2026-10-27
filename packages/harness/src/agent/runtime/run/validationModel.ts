/**
 * The deterministic model the package-validation gate runs against, and the
 * gate that selects it. Package validation (`TEXRA_CLI_INCLUDE_INTERNAL_
 * VALIDATION_MODEL=1`) swaps the provider models for this canned llm `Model`
 * at the provider boundary, so a `texra run` smoke test exercises the real
 * CLI and `executeAgent` path without a live model API.
 *
 * The four `TEXRA_CLI_*` reads are build constants: direct `process.env`
 * property access, so esbuild's `define` inlines them; only the CLI's
 * validation build defines them. Every shipped bundle loads a stub in place
 * of this module (`scripts/stub-internal-validation-model.mjs`). The runtime
 * keys go through the ambient `ConfigProvider` (`envVar`), read when the
 * program runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { Effect, Stream } from 'effect';
import {
  originOf,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from '@texra-ai/llm';
import { envVar } from '@utils/system/envFlags';
import { COMPACTION_SYSTEM_PROMPT } from './compaction';
import { SKIPPED_NOT_STARTED } from './tools';
import type { ModelConfig } from 'llm-zoo';

const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model.
`;

/** The validation fan-out: three structured `agent()` calls under one
 *  `Promise.allSettled`, each answered by the `prover` agent's schema. */
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
phase('Solve')
const results = await Promise.allSettled([
  agent('Find all integer solutions to x^2 - y^2 = 45.', { id: 'number-theory', agentName: 'prover', label: 'Solve the Diophantine equation', schema }),
  agent('Classify a real 3 by 3 matrix with A^2 = A and trace(A) = 2.', { id: 'linear-algebra', agentName: 'prover', label: 'Classify the matrix', schema }),
  agent('Compute whether HHT or THH appears first for a fair coin.', { id: 'probability', agentName: 'prover', label: 'Compute the stopping probability', schema }),
])
return { solutions: results.map((result) => result.status === 'fulfilled' ? result.value.structured : null) }`;

/** The golden store's script: finds the reading tool, two reads and a command
 *  in one `Promise.all`, then an agent it defines (`persona`). */
const GOLDEN_SCRIPT_SOURCE = `phase('Gather')
const [found] = await searchTools('read a file', { limit: 1 })
const declaration = await describeTool(found.name)
const [notes, shell] = await Promise.all([
  tools[found.name]({ path: 'notes.tex' }),
  tools.bash({ command: 'echo gathered', description: 'Say gathered' }),
])
return { found: found.name, documented: declaration.includes('path: string'), notes: notes.output, shell: shell.output, defined: (await agent('Answer from the notes.', { agentName: 'golden_reader', label: 'Defined agent', persona: { prompt: 'GOLDEN-CHILD: answer the task.', tools: ['read_file', 'executions'] } })).response }`;

/** The crash suite's background script: one awaited `agent()` call, whose
 *  child the background script run owns. */
const GOLDEN_BACKGROUND_SOURCE = `phase('Deliver')
const child = await agent('Background child: answer.', { agentName: 'golden_child', label: 'Child' })
return { delivered: child.response }`;

/** The crash-point conformance run's script: a read and a command in one
 *  `Promise.all`, then an awaited `agent()` call, whose child the call owns
 *  (`run.start.parent.callId`). */
const GOLDEN_CRASH_SOURCE = `phase('Gather')
const [notes, shell] = await Promise.all([
  tools.read_file({ path: 'notes.tex' }),
  tools.bash({ command: 'echo script >> effects.log', description: 'Record the script effect' }),
])
const child = await agent('Answer the conformance child task.', { agentName: 'golden_child', label: 'Child' })
return { notes: notes.output, shell: shell.output, child: child.response }`;

/** A reply of `value` alone. */
const text = (value: string): TurnResult['content'] => [
  { kind: 'message', content: [{ kind: 'text', text: value }] },
];

/** What the golden chat's goal round reports, and its result carries. */
const ANSWERED = 'The golden chat is answered.';

/** A tool call part, numbered by the model's response count. */
type CallPart = (name: string, input: unknown) => TurnResult['content'][number];

type ToolMessage = Extract<ResolvedTurn['messages'][number], { role: 'tool' }>;

/** What a golden part reads off its request: `said` is its messages as JSON
 *  and `results` its tool results, whose count is the part's step. */
interface GoldenRequest {
  readonly turn: ResolvedTurn;
  readonly system: string;
  readonly said: string;
  readonly results: ToolMessage[];
  readonly call: CallPart;
}

/** A scripted reply: its content, null for none, or content held until its
 *  `release` file appears beside the flag file. */
type GoldenReply =
  | TurnResult['content']
  | null
  | { readonly release: string; readonly content: TurnResult['content'] };

/** The golden store's scripted parts, keyed by the marker a system prompt
 *  carries and tried in order: the first marker the prompt contains answers. */
const GOLDEN_PARTS: Record<string, (request: GoldenRequest) => GoldenReply> = {
  // A call awaiting approval: the tool and command after the marker.
  'GOLDEN-APPROVAL': ({ system, results, call }) => {
    const [, asked = 'bash', command = 'echo approved >> approved.txt'] =
      /GOLDEN-APPROVAL(?: (\w+))?(?: (.+))?/.exec(system) ?? [];
    return results.length
      ? text('The approved command ran.')
      : [call(asked, { command })];
  },
  // A diagnostics read the service forwards to an attached window.
  'GOLDEN-DIAGNOSTICS': ({ results, call }) =>
    results.length === 0
      ? [call('diagnostics', { command: 'list', path: 'main.tex' })]
      : text('The diagnostics read came back.'),
  // A service task accepting a file from the run its instruction names.
  'GOLDEN-ACCEPT': ({ said, results, call }) => {
    const source = /\b([0-9a-f]{12})\b/.exec(said)?.[1];
    const files = [{ path: 'draft.tex', original: 'accepted.tex' }];
    return results.length > 0 || source === undefined
      ? text('Accepted.')
      : [call('accept_run_files', { execution_id: source, files })];
  },
  'GOLDEN-CHILD': ({ said, results, call }) => {
    // Messaging its waiting headless parent is refused (it never reads).
    if (!said.includes('Answer the delegated child task'))
      return text('Child result.');
    if (results.length === 0)
      return [
        call('executions', {
          path: '/executions',
          action: 'query',
          sql: "SELECT id FROM runs WHERE name = 'golden_parent'",
        }),
      ];
    const page = results[0]?.results
      .flatMap((result) => result.content)
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('\n');
    const parent = /^([0-9a-f]{12})$/m.exec(page ?? '')?.[1];
    return results.length === 1 && parent !== undefined
      ? [
          call('executions', {
            path: `/executions/${parent}`,
            action: 'send',
            message: 'The delegated child has a note for its parent.',
          }),
        ]
      : text('Child result.');
  },
  // The interactive chat: a plan run as a goal, its round and result, and
  // replies after a `/model` and a `/compact`, told apart by what they say.
  'GOLDEN-CHAT': ({ turn, said, results, call }) => {
    // A Codex child held until a stop; what is typed behind stays queued.
    if (said.includes('Hold this turn.'))
      return results.length === 0
        ? [call('codex', { prompt: 'Answer the Codex task.' })]
        : { release: 'golden-chat.release', content: text('Released.') };
    if (said.includes('The golden chat so far.'))
      return text('Answered after the compaction.');
    // The goal's round (`self()`): a command its grant approves, a verdict.
    const round = turn.tools.some(({ name }) => name === 'submit_output');
    const step = round
      ? [
          call('bash', { command: 'echo goal round', description: 'Goal' }),
          call('submit_output', { status: 'done', report: ANSWERED }),
        ]
      : [call('plan', { objective: 'Answer the golden chat, then stop.' })];
    if (round || results.length === 0)
      return step.slice(results.length, results.length + 1);
    if (said.includes('After the model switch.'))
      return text('Answered after the model switch.');
    return text(
      said.includes(ANSWERED)
        ? 'Golden chat goal complete.'
        : 'The plan runs as a goal.',
    );
  },
  'GOLDEN-SCRIPT': ({ turn, said, results, call }) => {
    // A background command waiting for its release file; its result wakes
    // the task once more.
    if (said.includes('Run in the background.')) {
      const last = turn.messages.at(-1);
      if (last?.role === 'tool') return text('Sent to the background.');
      return JSON.stringify(last).includes('Run in the background.')
        ? [
            call('bash', {
              command:
                'until [ -e ../bash.release ]; do sleep 0.05; done; echo released',
              description: 'Wait for the release',
              run_in_background: true,
            }),
          ]
        : text('The background command finished.');
    }
    return results.length === 0
      ? [
          call('script', {
            title: 'Gather the notes',
            code: GOLDEN_SCRIPT_SOURCE,
          }),
        ]
      : text('Script done.');
  },
  // The fork: each reply names its view's user messages by their last
  // lines, so the store records what the edit left.
  'GOLDEN-FORK': ({ turn }) => {
    const users = turn.messages.flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((part) =>
            part.kind === 'text' ? [part.text.trim().split('\n').at(-1)] : [],
          )
        : [],
    );
    return text(`Saw: ${users.join(' | ')}`);
  },
  // The crash suite's delivery run: three children, each reporting back.
  'GOLDEN-DELIVERY': ({ results, call }) =>
    results.length === 0
      ? [
          call('agent', {
            agentName: 'golden_child',
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
  // The crash-point run: two calls, a script, the echo's text. A step a crash
  // cut off unstarted is asked for again; a view an edit replaced no longer
  // holds the task, and the echo shows the view the edit left.
  'GOLDEN-CRASH': ({ said, results, call }) => {
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
      () => [call('script', { title: 'Gather', code: GOLDEN_CRASH_SOURCE })],
    ][done];
    return step === undefined || !said.includes('Work through the crash task.')
      ? null
      : step();
  },
  'GOLDEN-PARENT': ({ results, call }) => {
    const steps = [
      () => call('read_file', { path: 'notes.tex' }),
      () => call('plan', { objective: 'Read the notes and ask a child.' }),
      () =>
        call('agent', {
          agentName: 'golden_child',
          prompt: 'Answer the delegated child task.',
        }),
    ];
    const step = steps[results.length];
    return step === undefined ? text('Parent done.') : [step()];
  },
};

/**
 * The golden 1.0 store's scripted conversation (`generate-golden-store.mjs`):
 * a system prompt names its part, a step is its count of tool results, and a
 * held reply waits for its `*.release` file beside the flag file.
 */
function goldenTurn(
  turn: ResolvedTurn,
  flagPath: string,
  call: CallPart,
): Effect.Effect<TurnResult['content'] | null> {
  const system = turn.system ?? '';
  const said = JSON.stringify(turn.messages);
  // The golden chat's `/compact`: its summary replaces the history.
  if (system === COMPACTION_SYSTEM_PROMPT)
    return Effect.succeed(text('The golden chat so far.'));
  // The golden parent's session label: its `run.description`.
  if (
    system.startsWith('Generate a short TeXRA session label') &&
    said.includes('<agent>golden_parent</agent>')
  )
    return Effect.succeed(text('Working through the golden parent task'));
  const results = turn.messages.filter((m) => m.role === 'tool');
  const [, part] =
    Object.entries(GOLDEN_PARTS).find(([marker]) => system.includes(marker)) ??
    [];
  // A call naming GOLDEN-PARK (a label's too) waits for its release file.
  const reply: GoldenReply = (system + said).includes('GOLDEN-PARK')
    ? { release: 'golden-park.release', content: text('Parked run released.') }
    : (part?.({ turn, system, said, results, call }) ?? null);
  if (reply === null || !('release' in reply)) return Effect.succeed(reply);
  const file = path.join(path.dirname(flagPath), reply.release);
  return Effect.gen(function* () {
    while (!existsSync(file)) yield* Effect.sleep('20 millis');
    return reply.content;
  });
}

function mathematicalValidationOutput(prompt: string) {
  if (prompt.includes('x^2 - y^2'))
    return {
      answer:
        '(x,y) = (±23,±22), (±9,±6), and (±7,±2), with independent signs.',
      derivation:
        'Factor (x-y)(x+y)=45. The integer factor pairs of 45 with equal parity are (±1,±45), (±3,±15), and (±5,±9), including reversed signs. Solving x=(a+b)/2 and y=(b-a)/2 gives exactly the listed solutions.',
      check:
        'The factorization is bijective because x-y and x+y are odd divisors of 45; direct substitution gives differences of squares 45.',
    };
  if (prompt.includes('A^2 = A'))
    return {
      answer: 'A is similar over R to diag(1,1,0), and det(I+A)=4.',
      derivation:
        'The minimal polynomial divides t(t-1), whose roots are distinct, so A is diagonalizable with eigenvalues 0 and 1. The trace is the multiplicity of 1, hence it is 2.',
      check: 'I+A is similar to diag(2,2,1), whose determinant is 4.',
    };
  return {
    answer: 'The probability that HHT appears before THH is 1/4.',
    derivation:
      'Track the longest suffix that is a prefix of either target: empty, H, HH, T, and TH. First-step recursion gives p_empty=(p_H+p_T)/2, p_H=(p_HH+p_T)/2, p_HH=(p_HH+1)/2, p_T=(p_TH+p_T)/2, and p_TH=p_T/2. Hence p_HH=1, p_T=p_TH=0, p_H=1/2, and p_empty=1/4.',
    check:
      'Substitution satisfies every state equation and uses absorbing values 1 after HHT and 0 after THH.',
  };
}

/** The echo reply: the user messages the request carries, each by its last
 *  60 characters, which is what a fork or a compaction left of the view. */
function echoContent(turn: ResolvedTurn): TurnResult['content'] {
  if (turn.system === COMPACTION_SYSTEM_PROMPT)
    return text('Earlier turns, summarized.');
  const seen = turn.messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) =>
          part.kind === 'text' ? [part.text.slice(-60)] : [],
        )
      : [],
  );
  return text(`Model saw: ${seen.join(' | ')}`);
}

/** The reply outside the golden mode: the echo, the script fan-out's and the
 *  history query's call and then its result, else the polished document. */
function validationContent(
  turn: ResolvedTurn,
  scriptFanout: boolean,
  historyQuery: boolean,
  echo: boolean,
  call: CallPart,
): TurnResult['content'] {
  if (echo) return echoContent(turn);
  const toolNames = new Set(turn.tools.map((tool) => tool.name));
  const hasToolResult = turn.messages.some(({ role }) => role === 'tool');
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
        sql: 'SELECT name, kind, lifecycle FROM runs ORDER BY started_at',
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
  return text(
    `<documents><document name="paper.polished.tex">${VALIDATION_OUTPUT}</document></documents>`,
  );
}

/**
 * True only inside a guarded package-validation run: the bundle was built
 * with the include flag, the per-run env var is `1`, and an absolute flag
 * file holds the expected sentinel. `CI` is not read, so an interactive
 * `texra chat` (which a CI marker would force headless) can run against the
 * scripted model. Any partial/forged activation dies rather than silently
 * falling through to real models.
 */
export const shouldUseInternalValidationModel = Effect.fn(
  'shouldUseInternalValidationModel',
)(function* (): Effect.fn.Return<boolean> {
  if (process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL !== '1')
    return false;

  const envKey = process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_ENV ?? '';
  const flagEnvKey =
    process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV ?? '';
  const expectedFlagContent =
    process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_CONTENT ?? '';

  if ((yield* envVar(envKey)) !== '1') return false;

  const flagPath = yield* envVar(flagEnvKey);
  if (!flagPath || !path.isAbsolute(flagPath))
    return yield* Effect.die(
      new Error(
        `${envKey}=1 is restricted to package validation and needs an absolute ${flagEnvKey} path.`,
      ),
    );

  // An unreadable flag file dies with the filesystem error, which names it.
  const flagContent = yield* Effect.sync(() => readFileSync(flagPath, 'utf8'));
  if (flagContent.trim() !== expectedFlagContent)
    return yield* Effect.die(
      new Error(`${envKey}=1 received an invalid validation flag file.`),
    );

  return true;
});

/** The canned llm `Model` behind the validation backend. */
export function validationModel(config: ModelConfig): {
  readonly model: Model;
  readonly origin: ModelOrigin;
} {
  const origin = originOf({
    protocol: 'openai-responses',
    requestedModel: config.id,
    deployment: {
      endpoint: 'https://validation.invalid/v1',
      credentialScope: 'validation',
    },
  });
  let responses = 0;
  const call: CallPart = (name, input) => ({
    kind: 'local-call',
    providerCallId: `validation-${name}-${responses}`,
    name,
    argumentsText: JSON.stringify(input),
  });
  const prepareTurn: Model['prepareTurn'] = (request) =>
    Effect.succeed({
      ...origin,
      mode: 'foreground',
      system: request.system,
      messages: request.messages,
      tools: request.tools ?? [],
      transport: { kind: 'http' },
      controls: {
        temperature: 0,
        maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
        store: false,
        parallelToolCalls: true,
        toolChoice: request.toolChoice ?? 'auto',
        reasoning: null,
        serviceTier: null,
        ...(request.cacheKey === undefined
          ? {}
          : { promptCacheKey: request.cacheKey }),
      },
    });
  // Read per turn, so a validation run can flip them between turns.
  const streamTurn: Model['streamTurn'] = (turn) =>
    Stream.fromEffect(
      Effect.gen(function* () {
        responses += 1;
        const [scriptFanout, historyQuery, echo, golden] = (yield* Effect.all([
          envVar('TEXRA_INTERNAL_VALIDATE_SCRIPT_FANOUT'),
          envVar('TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY'),
          envVar('TEXRA_INTERNAL_VALIDATE_ECHO'),
          envVar('TEXRA_INTERNAL_VALIDATE_GOLDEN'),
        ])).map((value) => value === '1');
        const flagPath = yield* envVar(
          process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV ?? '',
        );
        const content =
          (golden && flagPath
            ? yield* goldenTurn(turn, flagPath, call)
            : null) ??
          validationContent(turn, scriptFanout, historyQuery, echo, call);
        // About four characters a token, so compaction can be crossed.
        const inputTokens = echo
          ? Math.ceil(JSON.stringify(turn.messages).length / 4)
          : 1;
        return {
          kind: 'http',
          providerResponseId: `validation-response-${responses}`,
          requestedOrigin: origin,
          returnedModel: config.id,
          modelFingerprint: null,
          content,
          finishReason: content.some((part) => part.kind === 'local-call')
            ? 'tool-calls'
            : 'stop',
          usage: {
            inputTokens,
            outputTokens: 1,
            totalTokens: inputTokens + 1,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
        } satisfies TurnResult;
      }),
    ).pipe(Stream.map((result): TurnEvent => ({ kind: 'completed', result })));
  return { origin, model: { prepareTurn, streamTurn } };
}
