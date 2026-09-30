/**
 * The deterministic model the package-validation gate runs against, and the
 * CI-only gate that selects it.
 *
 * Package validation (`pnpm --filter @texra-ai/cli run build` with
 * `TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL=1`) swaps the real provider
 * models for this canned llm `Model` at the provider boundary, so a
 * `texra run` smoke test exercises the full CLI + executeAgent path without
 * reaching a live model API. The provider boundary is the only deterministic
 * piece; the CLI and `executeAgent` path stays real.
 *
 * The four `TEXRA_CLI_*` reads are build constants: direct `process.env.<NAME>`
 * property access (never computed keys) so esbuild's `define`
 * (`packages/cli/scripts/build-bundle.mjs`) inlines them at bundle time; only
 * the CLI's package-validation build defines them non-empty. Every shipped
 * bundle (the default CLI, the desktop main process and the extension host)
 * loads a stub in place of this module
 * (`scripts/stub-internal-validation-model.mjs`), so no canned output and no
 * environment-opened gate ships. The
 * runtime keys (the per-run switch, the flag-file path, `CI`, and the per-turn
 * workflow-script switch) go through the ambient Effect `ConfigProvider`
 * (`envVar`), read when the program runs, never at module load.
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
} from '@texra-ai/llm/turn';
import { envVar } from '@utils/system/envFlags';
import type { ModelConfig } from 'llm-zoo';

const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model.
`;

const WORKFLOW_SCRIPT_VALIDATION_SOURCE = `export const meta = {
  name: 'cli-workflow-script-validation-v2',
  description: 'Solve three mathematical problems through the CLI',
  phases: [{ title: 'Solve' }],
  tasks: [
    { id: 'number-theory', label: 'Solve the Diophantine equation', phase: 'Solve' },
    { id: 'linear-algebra', label: 'Classify the matrix', phase: 'Solve' },
    { id: 'probability', label: 'Compute the stopping probability', phase: 'Solve' },
  ],
}
const schema = {
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
const results = yield* all([
  attempt(agent('Find all integer solutions to x^2 - y^2 = 45.', { id: 'number-theory', agentName: 'prover', schema })),
  attempt(agent('Classify a real 3 by 3 matrix with A^2 = A and trace(A) = 2.', { id: 'linear-algebra', agentName: 'prover', schema })),
  attempt(agent('Compute whether HHT or THH appears first for a fair coin.', { id: 'probability', agentName: 'prover', schema })),
])
return { solutions: results.map((result) => result._tag === 'Success' ? result.value.structured : null) }`;

/** The golden store's workflow script: one attempt of one agent, so its
 *  child runs alone and its rows commit in one order. */
const GOLDEN_WORKFLOW_SOURCE = `export const meta = {
  name: 'golden-workflow',
  description: 'One child through the workflow runner',
  phases: [{ title: 'Solve' }],
  tasks: [{ id: 'child', label: 'Answer the child task', phase: 'Solve' }],
}
phase('Solve')
const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }
const result = yield* attempt(agent('Answer the workflow child task.', { id: 'child', agentName: 'golden_child', schema }))
return { outcome: result._tag }`;

/**
 * The scripted conversation of the golden 1.0 store
 * (`packages/cli/scripts/generate-golden-store.mjs`): each agent's system
 * prompt names its part, and a part's step is the count of tool results its
 * history holds. The parked part's call is held until `golden-park.release`
 * exists beside the flag file: the generator kills the process holding it
 * instead, and the conformance suite creates the file before it resumes
 * the run.
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
  const tools = new Set(turn.tools.map((tool) => tool.name));
  const results = turn.messages.filter((m) => m.role === 'tool');
  const said = JSON.stringify(turn.messages);
  if (system.includes('GOLDEN-PARK'))
    return gate('golden-park.release').pipe(
      Effect.as(text('Parked run released.')),
    );
  if (system.includes('GOLDEN-CHILD')) {
    if (tools.has('submit_output'))
      return Effect.succeed(
        results.length === 0
          ? [call('submit_output', { answer: 'Workflow child answer.' })]
          : text('Workflow child done.'),
      );
    // The delegated child looks its parent up and messages it while the
    // parent waits on the delegation: a follow-up queued on a live run.
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
  if (!system.includes('GOLDEN-PARENT')) return Effect.succeed(null);
  const steps = [
    () => call('read_file', { path: 'notes.tex' }),
    () =>
      call('plan', {
        command: 'update',
        objective: 'Read the notes, run the workflow, and ask a child.',
      }),
    () =>
      call('delegate_multi_agents', {
        agent: 'correct',
        script: GOLDEN_WORKFLOW_SOURCE,
      }),
    () =>
      call('delegate_agent', {
        agent: 'golden_child',
        instruction: 'Answer the delegated child task.',
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
 * True only inside a guarded package-validation run: the include flag is set,
 * the per-run env var is `1`, `CI=1`, and an absolute flag file holds the
 * expected sentinel. Any partial/forged activation dies rather than silently
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
  const ci = yield* envVar('CI');
  if (ci !== '1' || !flagPath || !path.isAbsolute(flagPath)) {
    return yield* Effect.die(
      new Error(
        `${envKey}=1 is restricted to package validation with CI=1 and an absolute ${flagEnvKey} path.`,
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

/** The canned llm `Model` behind the validation compatibility key. */
export function validationModel(config: ModelConfig): {
  readonly model: Model;
  readonly origin: ModelOrigin;
} {
  const origin = originOf({
    protocol: 'openai-responses',
    requestedModel: config.fullName,
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
    workflowScript: boolean,
    historyQuery: boolean,
    golden: TurnResult['content'] | null,
  ): TurnResult => {
    const toolNames = new Set(turn.tools.map((tool) => tool.name));
    const hasToolResult = turn.messages.some(
      (message) => message.role === 'tool',
    );
    let content: TurnResult['content'];
    if (golden !== null) {
      content = golden;
    } else if (workflowScript && toolNames.has('submit_output')) {
      content = [
        call(
          'submit_output',
          mathematicalValidationOutput(JSON.stringify(turn.messages)),
        ),
      ];
    } else if (
      workflowScript &&
      !hasToolResult &&
      toolNames.has('delegate_multi_agents')
    ) {
      content = [
        call('delegate_multi_agents', {
          agent: 'correct',
          script: WORKFLOW_SCRIPT_VALIDATION_SOURCE,
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
    } else if (historyQuery) {
      // Hand the page back verbatim, so the run's result shows what the
      // query returned.
      const results = turn.messages.flatMap((message) =>
        message.role === 'tool' ? message.results : [],
      );
      content = [
        {
          kind: 'message',
          content: [
            {
              kind: 'text',
              text: `History query result: ${JSON.stringify(results)}`,
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
    return {
      kind: 'http',
      providerResponseId: `validation-response-${responses}`,
      requestedOrigin: origin,
      returnedModel: config.fullName,
      modelFingerprint: null,
      content,
      finishReason: calls ? 'tool-calls' : 'stop',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
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
        const [workflowScript, historyQuery, golden, flagPath] =
          yield* Effect.all([
            envVar('TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT'),
            envVar('TEXRA_INTERNAL_VALIDATE_HISTORY_QUERY'),
            envVar('TEXRA_INTERNAL_VALIDATE_GOLDEN'),
            envVar(
              process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_FLAG_ENV ?? '',
            ),
          ]);
        return complete(
          turn,
          workflowScript === '1',
          historyQuery === '1',
          golden === '1' && flagPath
            ? yield* goldenTurn(turn, flagPath, call)
            : null,
        );
      }),
    ).pipe(Stream.map((result): TurnEvent => ({ kind: 'completed', result })));
  return { origin, model: { prepareTurn, streamTurn } };
}
