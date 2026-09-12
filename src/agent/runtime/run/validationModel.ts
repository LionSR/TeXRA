/**
 * The deterministic model the package-validation gate runs against
 * (`TEXRA_INTERNAL_VALIDATION_MODEL_HANDLER=1`): the same canned turns the
 * validation handler serves the reflection family, as an llm `Model` for the
 * run loop. The provider boundary is the only deterministic piece; the CLI
 * and `executeAgent` path stays real.
 */
import { Effect, Stream } from 'effect';
import type {
  Model,
  ModelOrigin,
  ResolvedTurn,
  TurnEvent,
  TurnResult,
} from '@llm/turn';
import type { ModelConfig } from 'llm-zoo';

export const VALIDATION_OUTPUT = `\\section{Validated CLI Runtime}

This document was produced by the internal TeXRA CLI validation model handler.
`;

export const WORKFLOW_SCRIPT_VALIDATION_SOURCE = `export const meta = {
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
const results = await parallel([
  () => agent('Find all integer solutions to x^2 - y^2 = 45.', { id: 'number-theory', agentName: 'prover', schema }),
  () => agent('Classify a real 3 by 3 matrix with A^2 = A and trace(A) = 2.', { id: 'linear-algebra', agentName: 'prover', schema }),
  () => agent('Compute whether HHT or THH appears first for a fair coin.', { id: 'probability', agentName: 'prover', schema }),
])
return { solutions: results.map((result) => result?.structured ?? null) }`;

export function mathematicalValidationOutput(prompt: string): {
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

const VALIDATION_ENDPOINT = 'https://validation.invalid/v1';

/** The canned llm `Model` behind the validation compatibility key. */
export function validationModel(config: ModelConfig): {
  readonly model: Model;
  readonly origin: ModelOrigin;
} {
  const origin = {
    protocol: 'openai-chat',
    codecVersion: 1,
    requestedModel: config.fullName,
    deployment: {
      endpoint: VALIDATION_ENDPOINT,
      credentialScope: 'validation',
    },
  } as const satisfies ModelOrigin;
  let responses = 0;
  const complete = (turn: ResolvedTurn): TurnResult => {
    responses += 1;
    const toolNames = new Set(turn.tools.map((tool) => tool.name));
    const hasToolResult = turn.messages.some(
      (message) => message.role === 'tool',
    );
    const call = (name: string, input: unknown) =>
      ({
        kind: 'local-call',
        providerCallId: `validation-${name}-${responses}`,
        name,
        argumentsText: JSON.stringify(input),
      }) as const;
    let content: TurnResult['content'];
    if (
      process.env.TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT === '1' &&
      toolNames.has('submit_output')
    ) {
      content = [
        call(
          'submit_output',
          mathematicalValidationOutput(JSON.stringify(turn.messages)),
        ),
      ];
    } else if (
      process.env.TEXRA_INTERNAL_VALIDATE_WORKFLOW_SCRIPT === '1' &&
      !hasToolResult &&
      toolNames.has('delegate_multi_agents')
    ) {
      content = [
        call('delegate_multi_agents', {
          agent: 'correct',
          script: WORKFLOW_SCRIPT_VALIDATION_SOURCE,
        }),
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
      controls: {
        temperature: request.temperature ?? 0,
        maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
        parallelToolCalls: request.parallelToolCalls ?? true,
        toolChoice: request.toolChoice ?? 'auto',
        effort: null,
      },
    });
  const streamTurn: Model['streamTurn'] = (turn) => {
    const event: TurnEvent = { kind: 'completed', result: complete(turn) };
    return Stream.make(event);
  };
  return {
    origin,
    model: {
      prepareTurn,
      streamTurn,
      generateTurn: (turn) => Effect.sync(() => complete(turn)),
    },
  };
}
