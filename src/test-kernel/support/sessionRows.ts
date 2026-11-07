// Fixture rows several suites write: a run's `run.start` and one two-call
// tool-use turn, each built here so a row field renamed in the schema is
// renamed in one fixture.

// Local imports - harness
import {
  qualifyAggregateId,
  type RunId,
  type SessionRowDraft,
} from '@shared/schemas';
import type { RunHistoryDraft } from '@shared/session/runState';

type RunStartDraft = Extract<SessionRowDraft, { type: 'run.start' }>;
type HistoryDraft<T extends RunHistoryDraft['type']> = Extract<
  RunHistoryDraft,
  { type: T }
>;
type ToolResult = HistoryDraft<'tool.result'>;

/** The `run.start` of a root chat run that takes no follow-ups; `over`
 *  replaces any field. */
export const runStart = (
  runId: RunId,
  over: Partial<Omit<RunStartDraft, 'type' | 'aggregateId'>> = {},
): RunStartDraft => ({
  type: 'run.start',
  aggregateId: qualifyAggregateId('run', runId),
  identity: { kind: 'agent', agent: 'chat' },
  takesFollowUps: false,
  parent: null,
  provenance: null,
  ...over,
});

const ORIGIN = {
  protocol: 'openai-responses',
  requestedModel: 'gpt-test',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'openai',
  },
  codecVersion: 1,
} as const;
const INVOCATION = {
  invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d',
  attempt: 1,
} as const;
const RESPONSE_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
/** The provider's turn: a message and two `bash` calls. */
const TURN = {
  kind: 'http',
  providerResponseId: 'resp-1',
  requestedOrigin: ORIGIN,
  returnedModel: null,
  modelFingerprint: null,
  content: [
    { kind: 'message', content: [{ kind: 'text', text: 'running ls' }] },
    {
      kind: 'local-call',
      providerCallId: 'call-a',
      name: 'bash',
      argumentsText: '{"command":"ls"}',
    },
    {
      kind: 'local-call',
      providerCallId: 'call-b',
      name: 'bash',
      argumentsText: '{"command":"ls"}',
    },
  ],
  finishReason: 'tool-calls',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 4,
    cacheWriteTokens: null,
    reasoningTokens: null,
    toolUsePromptTokens: null,
  },
} as const;
/** The dispatch facts: two barrier calls, the second a duplicate of the
 *  first. */
const CALLS = [
  {
    callId: 'call-a',
    toolName: 'bash',
    lane: 'barrier',
    replay: 'unsafe',
    duplicateOf: null,
    logId: 'card-0',
  },
  {
    callId: 'call-b',
    toolName: 'bash',
    lane: 'barrier',
    replay: 'unsafe',
    duplicateOf: 'call-a',
    logId: 'card-1',
  },
] as const;
/** What the writer stamps beside `calls`: the runtime's priced usage. */
const TURN_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cost: 0.25,
  responseTimeMs: 1200,
  provider: 'openai-responses',
  cachedInputTokens: 4,
  cacheMissInputTokens: 6,
} as const;

/**
 * One tool-use turn of `runId` as the loop writes it, row by row: the user
 * message, the model attempt, its provider id, the response with its two
 * `bash` calls, the first call's intent, and the tool group that delivers
 * both results. `result` builds a call's `tool.result`; `over` replaces any
 * payload field.
 */
export function toolUseTurn(runId: RunId) {
  const aggregateId = qualifyAggregateId('run', runId);
  const append: HistoryDraft<'model.message'> = {
    type: 'model.message',
    aggregateId,
    payload: {
      kind: 'append',
      sourceResponse: null,
      messages: [
        { role: 'user', content: [{ kind: 'text', text: 'list the files' }] },
      ],
    },
  };
  const attempt: HistoryDraft<'model.message'> = {
    type: 'model.message',
    aggregateId,
    payload: {
      kind: 'attempt',
      request: '0'.repeat(64),
      invocation: INVOCATION,
      origin: ORIGIN,
    },
  };
  const identified: HistoryDraft<'model.message'> = {
    type: 'model.message',
    aggregateId,
    payload: {
      kind: 'identified',
      invocation: INVOCATION,
      providerResponseId: TURN.providerResponseId,
    },
  };
  const response: HistoryDraft<'model.message'> = {
    type: 'model.message',
    aggregateId,
    payload: {
      kind: 'response',
      responseId: RESPONSE_ID,
      invocation: INVOCATION,
      turn: TURN,
      calls: CALLS,
      usage: TURN_USAGE,
    },
  };
  const intent: HistoryDraft<'tool.intent'> = {
    type: 'tool.intent',
    aggregateId,
    payload: {
      origin: { kind: 'response', responseId: RESPONSE_ID },
      callId: 'call-a',
      attempt: 1,
    },
  };
  const delivery: HistoryDraft<'model.message'> = {
    type: 'model.message',
    aggregateId,
    payload: {
      kind: 'append',
      sourceResponse: RESPONSE_ID,
      messages: [
        {
          role: 'tool',
          results: CALLS.map((_, callOrdinal) => ({
            callOrdinal,
            status: 'success',
            content: [{ kind: 'text', text: 'ok' }],
          })),
        },
      ],
    },
  };
  const result = (
    callId: string,
    over: Partial<ToolResult['payload']> = {},
  ): ToolResult => ({
    type: 'tool.result',
    aggregateId,
    payload: {
      responseId: RESPONSE_ID,
      callId,
      attempt: 1,
      disposition: 'executed',
      duplicateOf: null,
      result: { status: 'executed', output: 'ok' },
      attachments: [],
      ...over,
    },
  });
  return {
    origin: ORIGIN,
    invocation: INVOCATION,
    responseId: RESPONSE_ID,
    providerTurn: TURN,
    calls: CALLS,
    append,
    attempt,
    identified,
    response,
    intent,
    delivery,
    result,
  };
}
