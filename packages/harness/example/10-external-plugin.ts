/**
 * Example 10 — A native plugin from a package outside the harness, removed
 * and restored.
 *
 * `acme-notes` is its own npm package (`acme-notes/`, packed and installed
 * beside the harness): a tool, a script module, a versioned fact kind and an
 * agent file it ships, all over the public entries.
 *
 * 1. With the plugin: starts the package's agent by name from its agent
 *    directory (`nodePlatform({ agentsDir })`). Its script imports
 *    `builtIn:notes`, which calls the plugin's tool, whose result states a
 *    `note` fact on the run.
 * 2. Reopens the store without the plugin or its agents. The exported trace
 *    still holds the fact, as written: its plugin, kind, version, run and
 *    commit, its value, and why it is not interpreted (`unavailable`). A
 *    resume of the run is refused as `pluginUnavailable`, naming the plugin,
 *    and the run listing shows the same reason.
 * 3. Reopens with the plugin again: the same fact reads interpreted, its
 *    value unchanged, and the run resumes with a message sent under an id,
 *    calls the tool and records the next note; the message's receipt
 *    (`followUp.receipt`) says a turn answered it.
 */
import { Effect, Layer, Schema } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';
import { acmeNotes, agentsDir as packageAgents, NoteSchema } from 'acme-notes';

import { makeExampleWorkspace, scriptReturnsOf } from './_support.ts';

const CODE = `
const { add } = await import('builtIn:notes');
return await add('Lemma 2 needs a citation.');`;
const FIRST = { text: 'Lemma 2 needs a citation.' };
const SECOND = { text: 'Section 3 is done.' };

const turns = [
  {
    expect: 'Note the draft.',
    toolCalls: [{ name: 'script', input: { code: CODE } }],
  },
  { expect: 'The script returned', text: 'Noted.' },
  {
    expect: 'Add a second note.',
    toolCalls: [{ name: 'note_add', input: SECOND }],
  },
  { expect: 'noted: Section 3 is done.', text: 'Both noted.' },
];
const withPlugin = await makeExampleWorkspace(turns, undefined, packageAgents);
// The same workspace and store, its agent directory its own (no agents).
const withoutPlugin = await makeExampleWorkspace([], withPlugin.workspace);
const { route } = withPlugin;

/** The session over `platform`'s store, and the run's `note` facts in its
 *  exported trace. */
const notesOf = (platform: typeof withPlugin.platform, runId: RunId) =>
  Effect.gen(function* () {
    const session = yield* (yield* Sessions).open(platform.roots, {
      persistent: true,
    });
    const exported = yield* session.records(runId).readTrace();
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
      agent: 'note_taker',
      instruction: 'Note the draft.',
      model: route.model,
    });
    const end = yield* run.result;
    const returned = scriptReturnsOf(
      yield* session.records(run.runId).readConversation(),
    );
    if (
      end.outcome !== 'completed' ||
      JSON.stringify(returned) !== JSON.stringify([FIRST])
    )
      throw new Error(`first run: ${JSON.stringify({ end, returned })}`);
    console.log(
      `[10] with acme-notes: agent note_taker from the package, script returned ${JSON.stringify(returned[0])}`,
    );
    return run.runId;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Sessions.layer({
        platform: withPlugin.platform,
        plugins: [...harnessBuiltins, acmeNotes],
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
    const listed = (yield* session.listRuns()).find(({ id }) => id === runId);
    if (
      refused._tag !== 'ResumeRefused' ||
      refused.reason.kind !== 'pluginUnavailable' ||
      refused.reason.plugin !== 'acme-notes' ||
      listed?.resumable !== false ||
      listed.resumeBlocked !== note.unavailable
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
    // delivers it, and its receipt says when a turn answered it.
    yield* session.request({
      kind: 'followUp.send',
      runId,
      id: 'second-note',
      text: 'Add a second note.',
    });
    const resumed = yield* session.resume(runId);
    const { receipt } = yield* session
      .request({
        kind: 'followUp.receipt',
        runId,
        id: 'second-note',
        wait: true,
      })
      .pipe(Effect.timeout('10 seconds'));
    yield* session.request({
      kind: 'run.stop',
      runId: resumed.runId,
      reason: 'user',
    });
    yield* session.settled;
    const { notes: after } = yield* notesOf(withPlugin.platform, runId);
    if (
      receipt.state !== 'answered' ||
      JSON.stringify(after.at(-1)?.value) !== JSON.stringify(SECOND)
    )
      throw new Error(
        `resume with the plugin: ${JSON.stringify({ receipt, after })}`,
      );
    console.log(
      `[10] with it again: the fact reads interpreted, value unchanged; the resumed run noted ${JSON.stringify(SECOND)}`,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Sessions.layer({
        platform: withPlugin.platform,
        plugins: [...harnessBuiltins, acmeNotes],
      }).pipe(Layer.provideMerge(route.transport)),
    ),
  ),
);
