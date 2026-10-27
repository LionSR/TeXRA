/**
 * Shared test-free support for the packed-tarball examples in `example/`.
 *
 * Builds a temporary workspace directory and wires `nodePlatform` with a
 * local loopback Anthropic Messages SSE server so every example runs
 * end-to-end through the real `Sessions` runtime, model route binding,
 * `@texra-ai/llm` wire decoder, tool loop, approval queue, SQLite store, and
 * view reducer without an external API key or internet access.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import type { AgentPlatform } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { Client, type Dispatcher, EnvHttpProxyAgent } from 'undici';

export interface ScriptedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly ScriptedToolCall[];
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

const dispatchSymbol = Object.getOwnPropertySymbols(
  EnvHttpProxyAgent.prototype,
).find((symbol) => symbol.description === 'dispatch');
if (!dispatchSymbol) {
  throw new Error('Could not locate undici EnvHttpProxyAgent dispatch symbol.');
}

let activeOrigin = '';
let activeClient: Dispatcher | undefined;
(
  EnvHttpProxyAgent.prototype as unknown as Record<
    symbol,
    Dispatcher['dispatch']
  >
)[dispatchSymbol] = function (options, handler) {
  if (!activeClient) {
    throw new Error(
      'No loopback model server installed for example workspace.',
    );
  }
  return activeClient.dispatch({ ...options, origin: activeOrigin }, handler);
};

export async function makeExampleWorkspace(
  turns: readonly ScriptedTurn[] = [],
): Promise<{
  readonly workspace: string;
  readonly agentsDir: string;
  readonly platform: AgentPlatform;
  readonly requests: Readonly<Record<string, unknown>>[];
}> {
  process.env.ANTHROPIC_API_KEY = 'example-test-key';
  const requests: Readonly<Record<string, unknown>>[] = [];
  let cursor = 0;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const parsed = (rawBody ? JSON.parse(rawBody) : {}) as Record<
      string,
      unknown
    >;

    if (rawBody.includes('Generate a short TeXRA session label')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(formatAnthropicSse({ text: 'Reviewing manuscript section' }, 0));
      return;
    }

    requests.push(parsed);
    const turnIndex = cursor++;
    const step = turns[turnIndex];
    if (!step) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Scripted model exhausted at turn ${turnIndex + 1}.`,
          },
        }),
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(formatAnthropicSse(step, turnIndex));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  activeOrigin = `http://127.0.0.1:${port}`;
  activeClient = new Client(activeOrigin);

  const workspace = await mkdtemp(join(tmpdir(), 'texra-harness-example-'));
  const agentsDir = join(workspace, 'agents');
  await mkdir(agentsDir, { recursive: true });
  const platform = nodePlatform({
    agentsDir,
    storageDir: join(workspace, 'storage'),
    workspaceDir: workspace,
  });
  await Effect.runPromise(
    platform.roots.globalState.update(
      'polishModel',
      'anthropic/claude-sonnet-5-5',
    ),
  );

  return {
    workspace,
    agentsDir,
    requests,
    platform,
  };
}
