import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProvider, type ModelConfig } from 'llm-zoo';
import { GoogleGenAI } from '@google/genai';

import { noopTrace, type AgentTrace } from '@agent/trace';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';
import * as providerConfigModule from '@utils/config/providerConfig';
import {
  fakeWorkspace,
  StreamingGoogleInteractionsHandler,
  userStep,
} from './googleInteractionsTestUtils';
import type { Interactions } from '@google/genai';

type Step = Interactions.Step;

/**
 * LIVE integration test against the real Google Interactions API. Opt-in only —
 * skipped unless LIVE_GEMINI=1 and GOOGLE_API_KEY are set, so it never runs in
 * normal CI. It drives the REAL ModelHandlerGoogleInteractions (not a
 * reimplementation) through a real GoogleGenAI client that is wrapped only to
 * record request params (store / background / previous_interaction_id / input
 * length) while delegating to the live endpoint.
 *
 * Run: GOOGLE_API_KEY=… LIVE_GEMINI=1 npx vitest run <thisfile>
 */
const LIVE = process.env.LIVE_GEMINI === '1' && !!process.env.GOOGLE_API_KEY;
const MODEL = process.env.LIVE_GEMINI_MODEL ?? 'gemini-3.5-flash';

interface CreateRec {
  store: boolean | undefined;
  background: boolean | undefined;
  previousId: string | undefined;
  inputLen: number;
  inputTypes: string[];
}

/** Wrap a real client so we can assert request shape without faking responses. */
function recordingClient(real: GoogleGenAI): {
  client: unknown;
  calls: { create: CreateRec[]; get: string[]; cancel: string[] };
} {
  const calls = {
    create: [] as CreateRec[],
    get: [] as string[],
    cancel: [] as string[],
  };
  const ix = real.interactions;
  const client = {
    interactions: {
      create: (params: never, options?: never) => {
        const p = params as unknown as {
          store?: boolean;
          background?: boolean;
          previous_interaction_id?: string;
          input?: Array<{ type?: string }>;
        };
        calls.create.push({
          store: p.store,
          background: p.background,
          previousId: p.previous_interaction_id,
          inputLen: Array.isArray(p.input) ? p.input.length : 0,
          inputTypes: Array.isArray(p.input)
            ? p.input.map((s) => s?.type ?? '?')
            : [],
        });
        return ix.create(params, options);
      },
      get: (id: string, params?: never, options?: never) => {
        calls.get.push(id);
        return ix.get(id, params, options);
      },
      cancel: (id: string, params?: never, options?: never) => {
        calls.cancel.push(id);
        return ix.cancel(id, params, options);
      },
    },
    models: real.models,
  };
  return { client, calls };
}

function liveConfig(): ModelConfig {
  return buildTestModelConfig({
    name: 'live-google-interactions',
    label: 'Live Google Interactions',
    fullName: MODEL,
    shortName: MODEL,
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 512,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 32768,
    capabilities: {
      supportsReasoning: false,
      supportsTokenCounting: false, // skip the extra countTokens round-trip
    },
    openRouterOnly: false,
  });
}

function mockConfig(background: boolean): void {
  const orig = configModule.getConfig;
  vi.spyOn(configModule, 'getConfig').mockImplementation(
    <T>(k: string, d?: T): T => {
      if (k === 'texra.model.useGoogleInteractionsServerState')
        return true as T;
      if (k === 'texra.model.useBackgroundResponses') return background as T;
      return orig(k, d);
    },
  );
  vi.spyOn(providerConfigModule, 'getProviderStreaming').mockReturnValue(false);
  vi.spyOn(providerConfigModule, 'getGlobalStreaming').mockReturnValue(false);
}

/** Real client wrapped for recording, driving the real handler. */
function liveHandler(category: AgentCategory): {
  client: unknown;
  calls: ReturnType<typeof recordingClient>['calls'];
  handler: ModelHandlerGoogleInteractions;
} {
  const real = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
  const { client, calls } = recordingClient(real);
  const handler = new ModelHandlerGoogleInteractions(liveConfig());
  handler.setLogger({ ...noopTrace });
  handler.setAgentCategory(category);
  return { client, calls, handler };
}

describe.skipIf(!LIVE)(`LIVE Google Interactions (${MODEL})`, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('S3/S1: store:true chaining sends a delta + previous_interaction_id on turn 2', async () => {
    mockConfig(/* background */ false);
    // ToolUse (non-workflow) ⇒ no background.
    const { client, calls, handler } = liveHandler(AgentCategory.ToolUse);

    // Turn 1 — full send, store:true, no chain.
    const messages: Step[] = [userStep('Reply with exactly: ALPHA')];
    const r1 = await handler.createResponse({
      client: client as never,
      messages,
      temperature: 0,
    });
    const t1 = handler.extractResponse(r1.response, '');

    console.log(
      '[live] turn1 text:',
      JSON.stringify(t1.text),
      'usage:',
      JSON.stringify(r1.response.usage),
    );

    expect(calls.create[0].store).toBe(true);
    expect(calls.create[0].previousId).toBeUndefined();
    expect(typeof r1.response.id).toBe('string');

    // Turn 2 — append a new user turn; handler must send only the delta + chain.
    messages.push(userStep('Now reply with exactly: BETA'));
    const r2 = await handler.createResponse({
      client: client as never,
      messages,
      temperature: 0,
    });
    const t2 = handler.extractResponse(r2.response, '');

    console.log(
      '[live] turn2 text:',
      JSON.stringify(t2.text),
      'usage:',
      JSON.stringify(r2.response.usage),
    );

    console.log('[live] create calls:', JSON.stringify(calls.create));

    expect(calls.create).toHaveLength(2);
    expect(calls.create[1].store).toBe(true);
    expect(calls.create[1].previousId).toBeTruthy(); // chained onto turn 1
    expect(calls.create[1].inputLen).toBe(1); // delta = just the new user step
    expect(t2.text.length).toBeGreaterThan(0);
  }, 120_000);

  it('background: workflow run submits background:true and polls to completion', async () => {
    mockConfig(/* background */ true);
    // Workflow ⇒ background eligible.
    const { client, calls, handler } = liveHandler(AgentCategory.Workflow);

    const r = await handler.createResponse({
      client: client as never,
      messages: [userStep('Reply with exactly: GAMMA')],
      temperature: 0,
    });
    const t = handler.extractResponse(r.response, '');

    console.log(
      '[live] background text:',
      JSON.stringify(t.text),
      'status:',
      r.response.status,
      'getPolls:',
      calls.get.length,
    );

    expect(calls.create[0].background).toBe(true);
    expect(calls.create[0].store).toBe(true);
    expect(calls.get.length).toBeGreaterThanOrEqual(1); // polled get(id)
    expect(r.response.status).toBe('completed');
    expect(t.text.length).toBeGreaterThan(0);
  }, 180_000);

  it('tool round-trip: chained round 2 sends function_result-only and completes', async () => {
    mockConfig(/* background */ false);
    const { client, calls, handler } = liveHandler(AgentCategory.ToolUse);

    const tools = [
      {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ];

    // Round 1 — model should emit a function_call (status requires_action).
    const messages: Step[] = [
      userStep('What is the weather in Paris? Use the get_weather tool.'),
    ];
    const r1 = await handler.createResponse({
      client: client as never,
      messages,
      temperature: 0,
      tools,
    });
    const toolCalls = handler.extractToolUse(r1.response);

    console.log(
      '[live] tool round1 status:',
      r1.response.status,
      'calls:',
      toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(','),
    );
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    // Build the follow-up exactly as the flow does, then append it.
    const followUp = await handler.createBatchedToolUseFollowUpMessages(
      [
        {
          call: toolCalls[0],
          result: { status: 'executed', output: 'Sunny, 22C' },
          attachments: [],
        },
      ],
      fakeWorkspace(),
      undefined,
    );
    messages.push(...followUp);

    const r2 = await handler.createResponse({
      client: client as never,
      messages,
      temperature: 0,
      tools,
    });
    const t2 = handler.extractResponse(r2.response, '');

    console.log(
      '[live] tool round2 status:',
      r2.response.status,
      'delta:',
      JSON.stringify(calls.create[1].inputTypes),
      'text:',
      JSON.stringify(t2.text.slice(0, 80)),
    );

    // Chained round 2 — delta is client-input only (no echoed function_call),
    // and it COMPLETES (the re-echo would 400).
    expect(calls.create[1].previousId).toBeTruthy();
    expect(
      calls.create[1].inputTypes.every(
        (t) => t === 'function_result' || t === 'user_input',
      ),
    ).toBe(true);
    expect(r2.response.status).toBe('completed');
    expect(t2.text.length).toBeGreaterThan(0);
  }, 120_000);

  it('streaming: the real SSE path assembles output and completes', async () => {
    mockConfig(/* background */ false);
    const real = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const { client } = recordingClient(real);

    // Capture streamed output appends to confirm the SSE path actually streamed.
    const appends: string[] = [];
    const streamLogger = {
      ...noopTrace,
      openStream: () => ({
        id: 's',
        append: (t: string) => appends.push(t),
        finalize: (t?: string) => t ?? appends.join(''),
      }),
    } as unknown as AgentTrace;

    const handler = new StreamingGoogleInteractionsHandler(liveConfig());
    handler.setLogger(streamLogger);
    handler.setOutputStreaming(true);
    handler.setAgentCategory(AgentCategory.ToolUse);

    const r = await handler.createResponse({
      client: client as never,
      messages: [userStep('Count from 1 to 5, separated by spaces.')],
      temperature: 0,
    });
    const t = handler.extractResponse(r.response, '');

    console.log(
      '[live] streaming status:',
      r.response.status,
      'appendChunks:',
      appends.length,
      'text:',
      JSON.stringify(t.text.slice(0, 80)),
    );

    // The real streaming SSE path assembled the output and completed. (Append
    // chunk count is logged for info but not asserted — short responses may
    // arrive without incremental text deltas, which is model-dependent.)
    expect(r.response.status).toBe('completed');
    expect(t.text.length).toBeGreaterThan(0);
  }, 120_000);
});
