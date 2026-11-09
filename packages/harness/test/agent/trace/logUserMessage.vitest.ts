import { Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import { RunIdSchema } from '@texra-ai/harness/schemas';
import { TraceEmitter, runEventDraft } from '@agent/trace/TraceEmitter';
import { logUserMessage } from '@agent/trace/traceLogs';
import { prepareEventDraft } from '@controllers/session/rowCodec';
import type { AgentEvent } from '@shared/session/agentEvent';
import { buildRunTranscript } from '@shared/session/transcriptUpdate';
import { EventsFrameSchema } from '@texra/shared/session/sessionFrames';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import type { AgentTrace } from '@texra-ai/harness/plugins';

// #7508: the userMessage row's attachment-kind/count payload — logUserMessage
// stamps data.attachments when attachments are present and stays byte-for-byte
// the same (no `data` at all) for the common no-media case.
describe('logUserMessage', () => {
  let logger: AgentTrace;
  let disposeTrace: () => void;
  let runTrace: ReturnType<typeof createTestRunTrace>;

  beforeEach(() => {
    runTrace = createTestRunTrace(
      Schema.decodeUnknownSync(RunIdSchema)('a5e0e5'),
    );
    logger = runTrace.trace;
    disposeTrace = runTrace.dispose;
  });

  afterEach(() => {
    disposeTrace();
  });

  // A live RPC frame must not turn absent JSON data into null and replace
  // the user's message with a malformed-payload diagnostic.
  it('keeps a payload-free user message through the live JSON RPC codec', () => {
    const events: AgentEvent[] = [];
    const trace = new TraceEmitter((event) => events.push(event));
    logUserMessage(trace, 'Second message');
    const event = events[0];
    assert(event);
    const draft = runEventDraft(
      Schema.decodeUnknownSync(RunIdSchema)('a5e0e5'),
      event,
    );
    assert(draft);
    const prepared = prepareEventDraft(draft);
    const frame = Schema.decodeUnknownSync(EventsFrameSchema)({
      kind: 'events',
      session: '/synthetic/project',
      generation: 0,
      cursor: 2,
      inputs: [
        {
          _tag: 'event',
          read: 'all',
          event: {
            type: 'run.start',
            aggregateId: draft.aggregateId,
            identity: { kind: 'agent', agent: 'chat' },
            takesFollowUps: true,
            parent: null,
            provenance: null,
            seq: 1,
            commit: 1,
            origin: null,
            at: 0,
          },
        },
        {
          _tag: 'event',
          read: 'all',
          event: { ...prepared.draft, seq: 2, commit: 2, origin: null, at: 1 },
        },
      ],
    });
    const codec = RpcSerialization.ndjson.codecFor(EventsFrameSchema);
    const parser = RpcSerialization.ndjson.makeUnsafe();
    const wire = parser.encode(Schema.encodeSync(codec)(frame));
    assert(wire !== undefined);
    const received = Schema.decodeUnknownSync(codec)(parser.decode(wire)[0]);
    const rows = buildRunTranscript(
      received.inputs.flatMap((input) =>
        input._tag === 'event' ? [input.event] : [],
      ),
      false,
    ).rows;
    expect(rows).toMatchObject([
      { kind: 'user', text: { full: 'Second message' } },
    ]);
  });

  // #13662, #13874: "Fork from here" refills the fork's composer from the
  // row, so the row keeps what the follow-up attached, by blob address: a
  // pasted file swept from storage leaves the fork its media.
  it('records the attached media a fork puts back in its composer', () => {
    const pasted = {
      name: 'pasted-image-1.png',
      mimeType: 'image/png',
      digest: 'a'.repeat(64),
    };
    logUserMessage(logger, 'See [pasted-image-1.png]', {
      attachments: ['image'],
      media: [pasted],
    });

    expect(runTrace.rows()[0]).toMatchObject({
      kind: 'user',
      attachments: ['image'],
      media: [pasted],
    });
  });
});
