/**
 * Example 10 — A native plugin from a package outside the harness, removed
 * and restored.
 *
 * `acme-notes` is its own npm package (`acme-notes/`, packed and installed
 * beside the harness): a tool, a script module, a program over that module
 * and a versioned fact kind, all over the public entries. It ships no agent:
 * the persona that uses it is the embedder's own, written inline.
 *
 * 1. With the plugin: the persona's script imports `builtIn:notes`, which
 *    calls the plugin's tool, whose result states a `note` fact on the run.
 * 2. Reopens the store without the plugin. The exported trace
 *    still holds the fact, as written: its plugin, kind, version, run and
 *    commit, its value, and why it is not interpreted (`unavailable`). A
 *    resume of the run is refused as `pluginUnavailable`, naming the plugin,
 *    and the run listing shows the same reason.
 * 3. Reopens with the plugin again: the same fact reads interpreted, its
 *    value unchanged, and the run resumes with a message queued for it. Its
 *    script starts the package's `notes` program by name
 *    (`program('notes', { args })`): a child run that asks no model, whose
 *    module calls the tool, so the next note is a fact of the program's run,
 *    and whose return is the script's result.
 */
import { Effect, Layer, Schema } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/builtins';
import { RunIdSchema, type RunId } from '@texra-ai/harness/schemas';
import { acmeNotes, NoteSchema } from 'acme-notes';

import {
  EXAMPLE_CLIENT,
  makeExampleWorkspace,
  scriptReturnsOf,
} from './_support.ts';

const CODE = `
const { add } = await import('builtIn:notes');
return await add('Lemma 2 needs a citation.');`;
const FIRST = { text: 'Lemma 2 needs a citation.' };
const SECOND = { text: 'Section 3 is done.' };
const PROGRAM_CODE = `
const { runId, structured } = await program('notes', { args: { notes: [${JSON.stringify(SECOND.text)}] } });
return { runId, kept: structured };`;
/** The embedder's persona: the package ships tools and a program, no agent. */
const NOTE_TAKER = {
  name: 'note_taker',
  description: 'Keeps notes on a draft.',
  prompt: 'Keep notes on the draft with a script.',
  tools: ['script', 'program', 'note_add'],
};

const turns = [
  {
    expect: 'Note the draft.',
    toolCalls: [{ name: 'script', input: { code: CODE } }],
  },
  { expect: 'The script returned', text: 'Noted.' },
  {
    expect: 'Add a second note.',
    toolCalls: [
      {
        name: 'script',
        input: { code: PROGRAM_CODE },
      },
    ],
  },
  { expect: 'The script returned', text: 'Both noted.' },
];
const withPlugin = await makeExampleWorkspace(turns);
// The same workspace and store.
const withoutPlugin = await makeExampleWorkspace([], withPlugin.workspace);
const { route } = withPlugin;

/** The session over `platform`'s store, and the run's `note` facts in its
 *  exported trace. */
const notesOf = (platform: typeof withPlugin.platform, runId: RunId) =>
  Effect.gen(function* () {
    const session = yield* (yield* Sessions).open(platform.roots, {
      persistent: true,
    });
    const exported = yield* session.records(runId).readTrace;
    if (exported.status !== 'ok')
      throw new Error(`no trace for ${runId}: ${exported.status}`);
    return {
      session,
      notes: exported.trace.events.flatMap((event) =>
        event.type === 'plugin.fact' && event.plugin === 'acme-notes'
          ? [event]
          : [],
      ),
    };
  });

// 1. With the plugin.
const runId = await Effect.runPromise(
  Effect.gen(function* () {
    const session = yield* (yield* Sessions).open(withPlugin.platform.roots, {
      persistent: true,
    });
    const run = yield* session.start({
      agent: NOTE_TAKER,
      instruction: 'Note the draft.',
      model: route.model,
      // Starting a program asks a person first; nobody is attached here to
      // answer, so the embedder approves the run's work at its start.
      approval: 'autoApprove',
    });
    const end = yield* run.result;
    const returned = scriptReturnsOf(
      yield* session.records(run.runId).readConversation,
    );
    if (
      end.outcome !== 'completed' ||
      JSON.stringify(returned) !== JSON.stringify([FIRST])
    )
      throw new Error(`first run: ${JSON.stringify({ end, returned })}`);
    console.log(
      `[10] with acme-notes: the script imported builtIn:notes and returned ${JSON.stringify(returned[0])}`,
    );
    return run.runId;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Sessions.layer({
        platform: withPlugin.platform,
        plugins: [...harnessBuiltins, acmeNotes],
        client: EXAMPLE_CLIENT,
      }).pipe(Layer.provideMerge(route.transport)),
    ),
  ),
);

// 2. Without it: the fact is kept as written and says why; no resume.
await Effect.runPromise(
  Effect.gen(function* () {
    const { session, notes } = yield* notesOf(withoutPlugin.platform, runId);
    const [note] = notes;
    if (
      notes.length !== 1 ||
      note?.version !== 1 ||
      JSON.stringify(note.value) !== JSON.stringify(FIRST) ||
      !note.unavailable?.includes('acme-notes')
    )
      throw new Error(`unavailable fact: ${JSON.stringify(notes)}`);
    console.log(
      `[10] without it: ${note.plugin}/${note.kind} v${note.version} at commit ${note.commit} of ${note.aggregateId}, value ${JSON.stringify(note.value)}: ${note.unavailable}`,
    );
    const refused = yield* Effect.flip(session.resume(runId));
    const listed = (yield* session.listRuns).find(({ id }) => id === runId);
    if (
      refused._tag !== 'ResumeRefused' ||
      refused.reason.kind !== 'pluginUnavailable' ||
      refused.reason.plugin !== 'acme-notes' ||
      listed?.continuation.kind !== 'blocked' ||
      listed.continuation.cause !== note.unavailable
    )
      throw new Error(
        `resume was not refused: ${JSON.stringify({ refused, listed })}`,
      );
    console.log(
      `[10] resume refused: ${refused.reason.kind} (${refused.reason.plugin}); the listing says why`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Sessions.layer({
        platform: withoutPlugin.platform,
        plugins: harnessBuiltins,
        client: EXAMPLE_CLIENT,
      }).pipe(Layer.provideMerge(route.transport)),
    ),
  ),
);

// 3. With it again: read interpreted, and the run continues.
await Effect.runPromise(
  Effect.gen(function* () {
    const { session, notes } = yield* notesOf(withPlugin.platform, runId);
    const [note] = notes;
    if (
      notes.length !== 1 ||
      note?.unavailable !== undefined ||
      JSON.stringify(Schema.decodeUnknownSync(NoteSchema)(note.value)) !==
        JSON.stringify(FIRST)
    )
      throw new Error(`restored fact: ${JSON.stringify(notes)}`);
    // A message to a run no process holds waits in its queue; the resume
    // delivers it, and the run, launched to run once, answers it and ends.
    yield* session.request({
      kind: 'followUp.send',
      runId,
      text: 'Add a second note.',
    });
    const resumed = yield* session.resume(runId);
    const end = yield* resumed.result.pipe(Effect.timeout('10 seconds'));
    yield* session.drained;
    const returned = Schema.decodeUnknownSync(
      Schema.Struct({ runId: RunIdSchema, kept: Schema.Unknown }),
    )(scriptReturnsOf(yield* session.records(runId).readConversation).at(-1));
    // The note is the program's: a fact of its own run.
    const { notes: kept } = yield* notesOf(withPlugin.platform, returned.runId);
    const programEnd = yield* session.records(returned.runId).readRunEnd;
    if (
      end.outcome !== 'completed' ||
      programEnd?.outcome !== 'completed' ||
      JSON.stringify(returned.kept) !== JSON.stringify([SECOND]) ||
      JSON.stringify(kept.map(({ value }) => value)) !==
        JSON.stringify([SECOND])
    )
      throw new Error(
        `resume with the plugin: ${JSON.stringify({ end, returned, programEnd, kept })}`,
      );
    console.log(
      `[10] with it again: the fact reads interpreted, value unchanged; the resumed run started program notes as run ${returned.runId}, which noted ${JSON.stringify(SECOND)}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Sessions.layer({
        platform: withPlugin.platform,
        plugins: [...harnessBuiltins, acmeNotes],
        client: EXAMPLE_CLIENT,
      }).pipe(Layer.provideMerge(route.transport)),
    ),
  ),
);
