import { describe, expect, it } from 'vitest';
import { type ModelConfig, ModelProvider, ReasoningEffort } from 'llm-zoo';

import { noopTrace } from '@agent/trace';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { ModelHandlerCodex } from '@agent/modelHandlers/openai/modelHandlerCodex';
import { AgentCategory } from '@shared/schemas/agent';
import { setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import type { Response } from 'openai/resources/responses/responses';

function config(): ModelConfig {
  return buildTestModelConfig({
    name: 'gpt-5.5',
    fullName: 'gpt-5.5',
    shortName: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200_000,
    // Codex eligibility comes from the registry's codexSubscription flag
    // (see providerCapabilities.ts), not from tier/naming heuristics.
    capabilities: {
      supportsReasoning: true,
      reasoningEffort: ReasoningEffort.XHIGH,
    },
    openRouterOnly: false,
    codexSubscription: true,
  });
}

function baseHandler(): ModelHandlerOpenAIResponse {
  const h = new ModelHandlerOpenAIResponse(config());
  h.setLogger(noopTrace);
  return h;
}

function codexHandler(): ModelHandlerCodex {
  const h = new ModelHandlerCodex(config());
  h.setAgentCategory(AgentCategory.ToolUse);
  h.setLogger(noopTrace);
  return h;
}

const reasoning = (enc: string) =>
  ({ type: 'reasoning', summary: [], encrypted_content: enc }) as never;
const webSearch = () => ({ type: 'web_search_call', id: 'ws1' }) as never;
const functionCall = () =>
  ({
    type: 'function_call',
    call_id: 'c1',
    name: 'foo',
    arguments: '{}',
  }) as never;

function responseWith(output: unknown[]): Response {
  return { output } as unknown as Response;
}

function encryptedBlobs(blocks: ReadonlyArray<{ type?: string }>): string[] {
  return blocks
    .filter((b) => b.type === 'reasoning')
    .map((b) => (b as { encrypted_content?: string }).encrypted_content ?? '');
}

describe('extractServerToolData reasoning preservation by store mode', () => {
  // The store:false (encrypted-reasoning) path is gated on the subscription
  // being active; turning it off drops the Codex handler to base behavior.
  setupPlatform({
    config: { 'texra.chatgptCodex.preferSubscription': true },
  });

  it('skips reasoning items that carry no encrypted_content (would be rejected empty)', () => {
    const summaryOnly = { type: 'reasoning', summary: [] } as never;
    const response = responseWith([summaryOnly, reasoning('enc1')]);

    const codexBlocks =
      codexHandler().extractServerToolData(response).contentBlocks;
    // Only the blob-carrying item survives.
    expect(encryptedBlobs(codexBlocks)).toEqual(['enc1']);
  });

  it('store:false (Codex) preserves every reasoning item carrying encrypted_content', () => {
    const response = responseWith([reasoning('enc1'), functionCall()]);

    // store:true base: no web_search_call, so no reasoning is preserved.
    expect(baseHandler().extractServerToolData(response).contentBlocks).toEqual(
      [],
    );

    // store:false Codex: the reasoning item is preserved for replay.
    const codexBlocks =
      codexHandler().extractServerToolData(response).contentBlocks;
    expect(encryptedBlobs(codexBlocks)).toEqual(['enc1']);
  });

  it('preserves reasoning + web_search in output order, store:true keeps only the paired reasoning', () => {
    const response = responseWith([
      reasoning('enc1'),
      webSearch(),
      reasoning('enc2'),
      functionCall(),
    ]);

    // store:true: reasoning-before-web_search + the web_search; the
    // function_call-preceding reasoning (enc2) is NOT kept (it's server-side).
    const baseBlocks =
      baseHandler().extractServerToolData(response).contentBlocks;
    expect(baseBlocks.map((b) => b.type)).toEqual([
      'reasoning',
      'web_search_call',
    ]);
    expect(encryptedBlobs(baseBlocks)).toEqual(['enc1']);

    // store:false: every reasoning item + web_search, in output order, so the
    // last reasoning still immediately precedes the replayed function_call.
    const codexBlocks =
      codexHandler().extractServerToolData(response).contentBlocks;
    expect(codexBlocks.map((b) => b.type)).toEqual([
      'reasoning',
      'web_search_call',
      'reasoning',
    ]);
    expect(encryptedBlobs(codexBlocks)).toEqual(['enc1', 'enc2']);
  });
});
