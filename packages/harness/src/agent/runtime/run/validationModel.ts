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

/** The golden store's script: finds the reading tool, then two reads and a
 *  command (a barrier, held until `golden-script.release`) in one
 *  `Promise.all`; the generator kills the process while the command runs. */
const GOLDEN_SCRIPT_SOURCE = `phase('Gather')
const [found] = await searchTools('read a file', { limit: 1 })
const declaration = await describeTool(found.name)
const [notes, shell, gate] = await Promise.all([
  tools[found.name]({ path: 'notes.tex' }),
  tools.bash({
    command: 'touch golden-script.started; until [ -f golden-script.release ]; do sleep 0.05; done; echo released',
    description: 'Wait for the release file',
  }),
  tools[found.name]({ path: 'golden-script.release' }),
])
console.log('gathered')
return { found: found.name, documented: declaration.includes('path: string'), notes: notes.output, shell: shell.output, gate: gate.summary }`;

/** The golden store's fan-out: two `agent()` calls under a child-run budget
 *  of 1; the second is held until `golden-fanout.release` and killed. */
const GOLDEN_FANOUT_SOURCE = `phase('Fan out')
const [a, b] = await Promise.all([
  agent('Fan-out child A: answer at once.', { agentName: 'golden_child', label: 'A' }),
  agent('Fan-out child B: answer once released.', { agentName: 'golden_child', label: 'B' }),
])
return { a: a.response, b: b.response }`;

/** The golden store's background script: one `agent()` call, held until
 *  `golden-background.release` and killed after the parent's turn ended. */
const GOLDEN_BACKGROUND_SOURCE = `phase('Background')
const answer = await agent('Background child: answer once released.', { agentName: 'golden_child', label: 'Child' })
return { answer: answer.response }`;

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

/**
 * The scripted conversation of the golden 1.0 store
 * (`generate-golden-store.mjs`): each agent's system prompt names its part,
 * and a part's step is the count of tool results its history holds. A held
 * call waits for its `*.release` file beside the flag file.
 */
function goldenTurn(
  turn: ResolvedTurn,
  flagPath: string,
  call: (name: string, input: unknown) => TurnResult['content'][number],
): Effect.Effect<TurnResult['content'] | null> {
  const text = (value: string): TurnResult['content'] => [
    { kind: 'message', content: [{ kind: 'text', text: value }] },
  ];
  const gate = (name: string) =>
    Effect.gen(function* () {
      const file = path.join(path.dirname(flagPath), name);
      while (!existsSync(file)) yield* Effect.sleep('20 millis');
    });
  const system = turn.system ?? '';
  const results = turn.messages.filter((m) => m.role === 'tool');
  const said = JSON.stringify(turn.messages);
  // The golden chat's `/compact`: its summary replaces the history.
  if (system === COMPACTION_SYSTEM_PROMPT)
    return Effect.succeed(text('The golden chat so far.'));
  if (system.includes('GOLDEN-PARK'))
    return gate('golden-park.release').pipe(
      Effect.as(text('Parked run released.')),
    );
  // A command that waits for its approval: the generator kills the process
  // while it waits, and the conformance suite resumes and approves it.
  if (system.includes('GOLDEN-APPROVAL'))
    return Effect.succeed(
      results.length === 0
        ? [call('bash', { command: 'echo approved >> approved.txt' })]
        : text('The approved command ran.'),
    );
  // A diagnostics read the service forwards to an attached window.
  if (system.includes('GOLDEN-DIAGNOSTICS'))
    return Effect.succeed(
      results.length === 0
        ? [call('diagnostics', { command: 'list', path: 'main.tex' })]
        : text('The diagnostics read came back.'),
    );
  if (system.includes('GOLDEN-CHILD')) {
    if (said.includes('Background child'))
      return gate('golden-background.release').pipe(
        Effect.as(text('Background child answer.')),
      );
    if (said.includes('Fan-out child B'))
      return gate('golden-fanout.release').pipe(
        Effect.as(text('Fan-out child B answer.')),
      );
    if (said.includes('Fan-out child A'))
      return Effect.succeed(text('Fan-out child A answer.'));
    // The delegated child looks its parent up and messages it while the
    // parent waits on the delegation: refused, since the headless parent
    // ends after its turn and would never read it.
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
  // The interactive chat: a plan the user runs as a goal, the goal
  // completed, a reply to the message sent after a `/model` switch, and one
  // to the message a `/compact` summarized. The compacted history has no
  // tool results, so its turns are told apart by what they say.
  if (system.includes('GOLDEN-CHAT')) {
    // The last turn is held until the user stops it, so the message typed
    // behind it stays queued on the stopped run.
    if (said.includes('Hold this turn.'))
      return gate('golden-chat.release').pipe(Effect.as(text('Released.')));
    if (said.includes('The golden chat so far.'))
      return Effect.succeed(text('Answered after the compaction.'));
    const steps = [
      () =>
        call('plan', {
          command: 'update',
          objective: 'Answer the golden chat, then stop.',
        }),
      () =>
        call('plan', {
          command: 'complete',
          reason: 'The golden chat is answered.',
        }),
    ];
    const step = steps[results.length];
    if (step !== undefined) return Effect.succeed([step()]);
    return Effect.succeed(
      text(
        said.includes('After the model switch.')
          ? 'Answered after the model switch.'
          : 'Golden chat goal complete.',
      ),
    );
  }
  if (system.includes('GOLDEN-SCRIPT'))
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
  // The fan-out script, then the same script again: its calls are reused.
  if (system.includes('GOLDEN-FANOUT')) {
    const step = [
      () => call('script', { title: 'Fan out', code: GOLDEN_FANOUT_SOURCE }),
      () =>
        call('script', { title: 'Fan out again', code: GOLDEN_FANOUT_SOURCE }),
    ][results.length];
    return Effect.succeed(
      step === undefined ? text('Fan-out done.') : [step()],
    );
  }
  // A script sent to the background, then the turn ends: its result comes
  // back as a follow-up, which the next turn acknowledges. The reply that
  // ends the launching turn waits for `golden-background-reply.release`:
  // the parent and its script run are two fibers of one process, so the
  // generator releases it once the script's child waits at its model call,
  // and the parent's last rows commit after the script's, not raced.
  if (system.includes('GOLDEN-BACKGROUND')) {
    if (results.length === 0)
      return Effect.succeed([
        call('script', {
          title: 'Background',
          code: GOLDEN_BACKGROUND_SOURCE,
          run_in_background: true,
        }),
      ]);
    if (said.includes('script-result'))
      return Effect.succeed(text('Background script reported.'));
    return gate('golden-background-reply.release').pipe(
      Effect.as(text('Background script sent.')),
    );
  }
  // The fork and its handoff: each reply names the user messages its view
  // held, each by its last line (a headless run's first message ends with
  // its instruction), so the store records what the edit left.
  if (system.includes('GOLDEN-FORK')) {
    const users = turn.messages.flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((part) =>
            part.kind === 'text' ? [part.text.trim().split('\n').at(-1)] : [],
          )
        : [],
    );
    return Effect.succeed(text(`Saw: ${users.join(' | ')}`));
  }
  // The crash suite's delivery run: three children, each reporting back.
  if (system.includes('GOLDEN-DELIVERY'))
    return Effect.succeed(
      results.length === 0
        ? [
            call('agent', {
              agentName: 'golden_child',
              prompt: 'Delivery child: answer.',
              background: true,
            }),
            call('script', {
              title: 'Deliver',
              code: "phase('Deliver')\nreturn { delivered: true }",
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
  // The crash-point conformance run: a response with two calls, then a
  // script, then the echo's text. A step a crash cut off before it started
  // (its calls settled as not started) is asked for again, as a model
  // decides to retry. A view an edit replaced (a handoff, a compaction, a
  // fork of either) no longer holds the task, and the echo answers it: what
  // it says shows the view the edit left.
  if (system.includes('GOLDEN-CRASH')) {
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
    return Effect.succeed(
      step === undefined || !said.includes('Work through the crash task.')
        ? null
        : step(),
    );
  }
  if (!system.includes('GOLDEN-PARENT')) return Effect.succeed(null);
  const steps = [
    () => call('read_file', { path: 'notes.tex' }),
    () =>
      call('plan', {
        command: 'update',
        objective: 'Read the notes and ask a child.',
      }),
    () =>
      call('agent', {
        agentName: 'golden_child',
        prompt: 'Answer the delegated child task.',
      }),
  ];
  const step = steps[results.length];
  return Effect.succeed(step === undefined ? text('Parent done.') : [step()]);
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
  if (!flagPath || !path.isAbsolute(flagPath)) {
    return yield* Effect.die(
      new Error(
        `${envKey}=1 is restricted to package validation and needs an absolute ${flagEnvKey} path.`,
      ),
    );
  }

  // An unreadable flag file dies with the filesystem error, which names it.
  const flagContent = yield* Effect.sync(() => readFileSync(flagPath, 'utf8'));
  if (flagContent.trim() !== expectedFlagContent) {
    return yield* Effect.die(
      new Error(`${envKey}=1 received an invalid validation flag file.`),
    );
  }

  return true;
});

const VALIDATION_ENDPOINT = 'https://validation.invalid/v1';

/** The canned llm `Model` behind the validation backend. */
export function validationModel(config: ModelConfig): {
  readonly model: Model;
  readonly origin: ModelOrigin;
} {
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
  const complete = (
    turn: ResolvedTurn,
    scriptFanout: boolean,
    historyQuery: boolean,
    echo: boolean,
    golden: TurnResult['content'] | null,
  ): TurnResult => {
    const toolNames = new Set(turn.tools.map((tool) => tool.name));
    const hasToolResult = turn.messages.some(
      (message) => message.role === 'tool',
    );
    let content: TurnResult['content'];
    if (golden !== null) {
      content = golden;
    } else if (echo && turn.system === COMPACTION_SYSTEM_PROMPT) {
      content = [
        {
          kind: 'message',
          content: [{ kind: 'text', text: 'Earlier turns, summarized.' }],
        },
      ];
    } else if (echo) {
      // The user messages the request carries, in order, each by its last
      // 60 characters: what a fork, a reset, a handoff or a compaction left
      // of the model's view.
      const seen = turn.messages.flatMap((message) =>
        message.role === 'user'
          ? message.content.flatMap((part) =>
              part.kind === 'text' ? [part.text.slice(-60)] : [],
            )
          : [],
      );
      content = [
        {
          kind: 'message',
          content: [{ kind: 'text', text: `Model saw: ${seen.join(' | ')}` }],
        },
      ];
    } else if (scriptFanout && toolNames.has('submit_output')) {
      content = [
        call(
          'submit_output',
          mathematicalValidationOutput(JSON.stringify(turn.messages)),
        ),
      ];
    } else if (scriptFanout && !hasToolResult && toolNames.has('script')) {
      content = [
        call('script', {
          title: 'Solve the validation problems',
          code: SCRIPT_FANOUT_VALIDATION_SOURCE,
        }),
      ];
    } else if (historyQuery && !hasToolResult && toolNames.has('executions')) {
      content = [
        call('executions', {
          path: '/executions',
          action: 'query',
          sql: 'SELECT name, kind, lifecycle FROM runs ORDER BY started_at',
        }),
      ];
    } else if ((scriptFanout && toolNames.has('script')) || historyQuery) {
      // Hand the result back verbatim, so the run's report shows what the
      // script's children answered or what the query returned.
      const results = turn.messages.flatMap((message) =>
        message.role === 'tool' ? message.results : [],
      );
      const what = scriptFanout ? 'Script' : 'History query';
      content = [
        {
          kind: 'message',
          content: [
            {
              kind: 'text',
              text: `${what} result: ${JSON.stringify(results)}`,
            },
          ],
        },
      ];
    } else {
      content = [
        {
          kind: 'message',
          content: [
            {
              kind: 'text',
              text: `<documents><document name="paper.polished.tex">${VALIDATION_OUTPUT}</document></documents>`,
            },
          ],
        },
      ];
    }
    const calls = content.some((part) => part.kind === 'local-call');
    // The echo counts its input as a provider would, about four characters
    // a token, so the compaction threshold can be crossed.
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
      finishReason: calls ? 'tool-calls' : 'stop',
      usage: {
        inputTokens,
        outputTokens: 1,
        totalTokens: inputTokens + 1,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    };
  };
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
  // The scenario switches are read per turn, so a validation run can flip
  // them between turns.
  const streamTurn: Model['streamTurn'] = (turn) =>
    Stream.fromEffect(
      Effect.gen(function* () {
        responses += 1;
        const [scriptFanout, historyQuery, echo, golden, flagPath] =
          yield* Effect.all([
            envVar('TEXRA_INTERNAL_VALIDATE_SCRIPT_FANOUT'),
            envVar('TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY'),
            envVar('TEXRA_INTERNAL_VALIDATE_ECHO'),
            envVar('TEXRA_INTERNAL_VALIDATE_GOLDEN'),
            envVar(
              process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV ?? '',
            ),
          ]);
        return complete(
          turn,
          scriptFanout === '1',
          historyQuery === '1',
          echo === '1',
          golden === '1' && flagPath
            ? yield* goldenTurn(turn, flagPath, call)
            : null,
        );
      }),
    ).pipe(Stream.map((result): TurnEvent => ({ kind: 'completed', result })));
  return { origin, model: { prepareTurn, streamTurn } };
}
