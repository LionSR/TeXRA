import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'vitest';

import type {
  Response,
  ResponseCompletedEvent,
  ResponseCreatedEvent,
} from 'openai/resources/responses/responses';

type MetadataEvent = {
  type: 'response.metadata';
  [key: string]: unknown;
};

type AccumulateResponse = (
  event: MetadataEvent | ResponseCreatedEvent | ResponseCompletedEvent,
  snapshot?: Response,
) => Response;

const nodeRequire = createRequire(import.meta.url);

function createResponse(status: 'in_progress' | 'completed'): Response {
  return {
    id: 'resp_metadata_test',
    created_at: 1,
    output_text: status,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-4.1',
    object: 'response',
    output: [],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status,
  };
}

function assertMetadataIsIgnored(
  accumulateResponse: AccumulateResponse,
  event: MetadataEvent,
  snapshot: Response,
): Response {
  const before = structuredClone(snapshot);
  const result = accumulateResponse(event, snapshot);

  assert.equal(result, snapshot);
  assert.deepEqual(result, before);
  assert.equal('internal' in result, false);
  return result;
}

function assertLifecycleSequence(accumulateResponse: AccumulateResponse): void {
  const metadata = {
    type: 'response.metadata',
    sequence_number: 1,
    internal: { opaque: true },
  } as const satisfies MetadataEvent;

  assert.throws(
    () => accumulateResponse(metadata),
    /expected 'response.created' event/,
  );

  let snapshot = accumulateResponse({
    type: 'response.created',
    sequence_number: 0,
    response: createResponse('in_progress'),
  });
  snapshot = assertMetadataIsIgnored(accumulateResponse, metadata, snapshot);

  snapshot = accumulateResponse(
    {
      type: 'response.completed',
      sequence_number: 2,
      response: createResponse('completed'),
    },
    snapshot,
  );
  assertMetadataIsIgnored(
    accumulateResponse,
    { ...metadata, sequence_number: 3 },
    snapshot,
  );
}

describe('OpenAI ResponseAccumulator response.metadata compatibility', () => {
  const runtimes = [
    {
      name: 'CJS',
      load: async () =>
        nodeRequire('openai/lib/responses/ResponseAccumulator.js') as {
          accumulateResponse: AccumulateResponse;
        },
    },
    {
      name: 'ESM',
      load: async () =>
        (await import('openai/lib/responses/ResponseAccumulator.mjs')) as {
          accumulateResponse: AccumulateResponse;
        },
    },
  ];

  it.each(runtimes)(
    'preserves the response snapshot in the $name runtime',
    async ({ load }) => {
      const { accumulateResponse } = await load();

      assertLifecycleSequence(accumulateResponse);
    },
  );
});
