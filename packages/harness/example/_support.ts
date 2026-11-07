/**
 * Shared test-free support for the packed-tarball examples in `example/`.
 *
 * Builds a temporary workspace directory and `nodePlatform`, and answers the
 * model requests with an in-memory Anthropic Messages SSE fetch supplied as
 * the harness's `ModelFetch`, so every example runs end-to-end through the
 * real `Sessions` runtime, model route binding, `@texra-ai/llm` wire decoder,
 * tool loop, approval queue, SQLite store, and view reducer without an
 * external API key or internet access.
 *
 * `TEXRA_EXAMPLE_MODEL` (a `provider/model` string such as
 * `anthropic/claude-sonnet-5-5`) selects a real route instead: no fetch is
 * supplied, the harness's own transport carries the requests, and the
 * provider's API key comes from its usual environment variable.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Layer } from 'effect';
import { ModelFetch, type AgentPlatform } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import type { ExportNode } from '@texra-ai/harness/host';

export interface ScriptedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
  /** Text the request answered by this turn must contain: a request out of
   *  the planned order is refused with a 400, which no retry resends. */
  readonly expect?: string;
}

function formatAnthropicSse(step: ScriptedTurn, turnIndex: number): string {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: `msg_example_${turnIndex + 1}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 120,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];

  let nextBlockIndex = 0;
  if (step.text) {
    const index = nextBlockIndex++;
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: step.text },
      },
      { type: 'content_block_stop', index },
    );
  }

  for (const [callIndex, call] of (step.toolCalls ?? []).entries()) {
    const index = nextBlockIndex++;
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id ?? `call_${turnIndex + 1}_${callIndex + 1}`,
          name: call.name,
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(call.input),
        },
      },
      { type: 'content_block_stop', index },
    );
  }

  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: step.toolCalls?.length ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 40 },
    },
    { type: 'message_stop' },
  );

  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

/** The scripted model: each request answered by the next turn, in order. */
function scriptedFetch(
  turns: readonly ScriptedTurn[],
  requests: Readonly<Record<string, unknown>>[],
): typeof fetch {
  let cursor = 0;
  const error = (status: number, type: string, message: string) =>
    Response.json({ type: 'error', error: { type, message } }, { status });
  const stream = (step: ScriptedTurn, turnIndex: number) =>
    new Response(formatAnthropicSse(step, turnIndex), {
      headers: { 'content-type': 'text/event-stream' },
    });

  return async (input, init) => {
    const rawBody = await new Request(input, init).text();
    requests.push(
      (rawBody ? JSON.parse(rawBody) : {}) as Record<string, unknown>,
    );
    const turnIndex = cursor++;
    const step = turns[turnIndex];
    if (!step) {
      return error(
        500,
        'api_error',
        `Scripted model exhausted at turn ${turnIndex + 1}.`,
      );
    }
    if (step.expect !== undefined && !rawBody.includes(step.expect)) {
      const message = `Scripted turn ${turnIndex + 1} expected a request containing ${JSON.stringify(step.expect)}.`;
      console.error(message);
      return error(400, 'invalid_request_error', message);
    }
    return stream(step, turnIndex);
  };
}

/** The real route `TEXRA_EXAMPLE_MODEL` names, if any. */
const realModel = process.env.TEXRA_EXAMPLE_MODEL?.trim() || undefined;

export async function makeExampleWorkspace(
  turns: readonly ScriptedTurn[] = [],
  /** An existing workspace to reuse, as a second process does. */
  existing?: string,
  /** The agent directory the platform serves, a plugin package's own;
   *  absent, the workspace's `agents/`. */
  agents?: string,
): Promise<{
  readonly workspace: string;
  readonly agentsDir: string;
  readonly platform: AgentPlatform;
  /** The scripted model's requests, in order; empty on a real route. */
  readonly requests: Readonly<Record<string, unknown>>[];
  /** The route the example's runs take: the model they start with, and
   *  what to merge beneath `Sessions.layer` (the scripted model's
   *  `ModelFetch`, or nothing on a real route). `Layer.empty` is no
   *  `Layer<ModelFetch>`, so the type is the union of the two cases. */
  readonly route: {
    readonly model: string;
    readonly transport: Layer.Layer<ModelFetch> | Layer.Layer<never>;
  };
}> {
  const requests: Readonly<Record<string, unknown>>[] = [];
  const scripted = realModel === undefined;
  if (scripted) {
    process.env.ANTHROPIC_API_KEY = 'example-test-key';
  }

  const workspace =
    existing ?? (await mkdtemp(join(tmpdir(), 'texra-harness-example-')));
  const agentsDir = agents ?? join(workspace, 'agents');
  await mkdir(agentsDir, { recursive: true });
  const platform = nodePlatform({
    agentsDir,
    storageDir: join(workspace, 'storage'),
    workspaceDir: workspace,
  });
  return {
    workspace,
    agentsDir,
    requests,
    platform,
    route: {
      model: realModel ?? 'anthropic/claude-sonnet-5-5',
      transport: scripted
        ? Layer.succeed(ModelFetch)(scriptedFetch(turns, requests))
        : Layer.empty,
    },
  };
}

/** What each `script` call of a stored conversation returned, in order:
 *  the structured `value` its result node carries
 *  (`records(runId).readConversation`); a call node is followed by its
 *  result node. */
export function scriptReturnsOf(
  conversation: readonly ExportNode[],
): unknown[] {
  return conversation.flatMap((node, index) => {
    const call = conversation[index - 1];
    return node.kind === 'tool-result' &&
      call?.kind === 'tool-call' &&
      call.name === 'script' &&
      node.value !== undefined
      ? [node.value]
      : [];
  });
}
