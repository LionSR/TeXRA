import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';
import { GoogleGenAI } from '@google/genai';

import type { AgentTrace } from '@agent/trace';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import * as configModule from '@utils/config/configUtils';
import * as providerConfigModule from '@utils/config/providerConfig';
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
          input?: unknown[];
        };
        calls.create.push({
          store: p.store,
          background: p.background,
          previousId: p.previous_interaction_id,
          inputLen: Array.isArray(p.input) ? p.input.length : 0,
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
  return {
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
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsReasoning: false,
      supportsTokenCounting: false, // skip the extra countTokens round-trip
    },
    openRouterOnly: false,
  };
}

function logger(): AgentTrace {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    domain: () => undefined,
    openStream: () => ({
      id: 's',
      append: () => undefined,
      finalize: (t?: string) => t ?? '',
    }),
  } as unknown as AgentTrace;
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

function userStep(text: string): Step {
  return { type: 'user_input', content: [{ type: 'text', text }] };
}

describe.skipIf(!LIVE)(`LIVE Google Interactions (${MODEL})`, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('S3/S1: store:true chaining sends a delta + previous_interaction_id on turn 2', async () => {
    mockConfig(/* background */ false);
    const real = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const { client, calls } = recordingClient(real);

    const handler = new ModelHandlerGoogleInteractions(liveConfig());
    handler.setLogger(logger());
    handler.setAgentCategory(AgentCategory.ToolUse); // non-workflow ⇒ no background

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
    const real = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
    const { client, calls } = recordingClient(real);

    const handler = new ModelHandlerGoogleInteractions(liveConfig());
    handler.setLogger(logger());
    handler.setAgentCategory(AgentCategory.Workflow); // ⇒ background eligible

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
});
