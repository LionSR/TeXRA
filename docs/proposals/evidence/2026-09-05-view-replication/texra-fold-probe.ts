/**
 * Reproduction of the original fold-only probe against TeXRA
 * 3958a96edd453938e023f163c1aa5b358854d89d. This measures sequential readers
 * of one synthetic flat transcript, not concurrent clients or transport.
 * The build helper exposes the private event schema in the temporary bundle
 * so every fixture event is validated without editing production source.
 */
import { performance } from 'node:perf_hooks';
import { fold } from '@shared/session/sessionFold';
import { emptySessionView } from '@shared/session/sessionView';
import { SessionEventSchema } from '@shared/schemas/sessionEvent';
const owner = '4242:2026-09-05T00:00:00Z';
const id = 'agent#aaaaaaaaaaaa';
const events: any[] = [];
function event(body: any) {
  const n = events.length + 1;
  const e = SessionEventSchema.parse({
    aggregateId: id,
    seq: n,
    commit: n,
    ownerId: owner,
    at: n,
    ...body,
  });
  const input = { _tag: 'event', read: 'all', event: e };
  events.push(input);
  return input;
}
event({
  type: 'run.start',
  executionId: 'aaaaaaaaaaaa',
  identity: { kind: 'agent', agent: 'custom:review' },
  category: 'toolUse',
  isRemote: false,
  userFollowUpSupport: 'nativeInteractive',
});
event({
  type: 'status',
  phase: 'running',
  cause: 'lifecycle',
  runStartedAt: 1,
});
for (let n = 0; n < 10000; n++)
  event({
    type: 'transcript.entry',
    entry: {
      id: 'row-' + n,
      type: 'log',
      messageType: 'modelResponse',
      text: 'Example mathematical argument ' + n + ' ' + 'x'.repeat(200),
      data: { status: 'completed' },
      seqNo: n + 1,
      timestamp: n + 1,
      level: 'info',
    },
  });
const start = () =>
  fold(emptySessionView('paper'), [
    { _tag: 'subscriptions', set: [{ id, fromSeq: 0 }] },
    { _tag: 'local', local: { self: [owner], heldBy: [], unreadable: [] } },
  ] as any);
function replay() {
  let v = start();
  for (let i = 0; i < events.length; i += 64)
    v = fold(v, events.slice(i, i + 64));
  if (v.streams.get(id)?.transcript.rows.length !== 10000) throw Error('rows');
  return v;
}
replay();
const results = [];
for (const readers of [1, 3, 10]) {
  const times = [];
  for (let rep = 0; rep < 5; rep++) {
    globalThis.gc?.();
    const t = performance.now();
    for (let c = 0; c < readers; c++) replay();
    times.push(performance.now() - t);
  }
  results.push({
    readers,
    ms: times,
    medianMs: times.toSorted((a, b) => a - b)[2],
  });
}
const before = replay();
const priorStream = before.streams.get(id)!;
const priorRows = priorStream.transcript.rows.length;
const newEvent = event({
  type: 'transcript.entry',
  entry: {
    id: 'row-final',
    type: 'log',
    messageType: 'modelResponse',
    text: 'final',
    data: { status: 'completed' },
    seqNo: 10001,
    timestamp: 10001,
    level: 'info',
  },
});
const after = fold(before, newEvent as any);
const ownerView = fold(start(), events.slice(0, 2));
let observerView = fold(emptySessionView('paper'), [
  { _tag: 'local', local: { self: [], heldBy: [owner], unreadable: [] } },
  ...events.slice(0, 2),
] as any);
console.log(
  JSON.stringify(
    {
      node: process.version,
      fixture:
        '10000 schema-validated completed assistant rows, 64-input frames, one flat stream; fold only, no IO/parse/wire/UI/immutable publication',
      results,
      retainedView: {
        beforeCursor: before.cursor,
        afterCursor: after.cursor,
        priorRows,
        retainedRowsNow: priorStream.transcript.rows.length,
        sameStreamsMap: before.streams === after.streams,
      },
      viewpoint: {
        ownerReadOnly: ownerView.streams.get(id)?.readOnly,
        observerReadOnly: observerView.streams.get(id)?.readOnly,
      },
      wireShape: {
        jsonStreams: JSON.parse(JSON.stringify(after)).streams,
        actualStreams: after.streams.size,
      },
    },
    null,
    2,
  ),
);
