/**
 * The chat-session controller over a real session: its runs start, resume
 * and stop on a persistent session over the validation host, whose model is
 * the only fake (the bundled `assistant` answers with what it was sent).
 * Each case drives the controller's public verbs (`submit`, `resume`,
 * `stop`) and reads what the person and the process get: the run's view,
 * the session's stored rows, and the chat's exit code.
 *
 * Failure modes:
 * - a Ctrl-C while a resumed run rehydrates is lost, and the run keeps going;
 * - a run whose end is lost exits as a success because the chat was leaving;
 * - a message typed around a stop is dropped, reordered, or starts a second
 *   root beside the stopped one;
 * - a stop or a message asked while the first launch is on its way is lost,
 *   or starts a second root;
 * - a root whose result cannot be read exits as a success;
 * - a resume of a run that does not exist exits as a success;
 * - a message's late reply that resumed the old root takes the chat's root
 *   back from the conversation the user resumed meanwhile.
 */
import { computed } from '@lit-labs/signals';
import { layer } from '@effect/vitest';
import {
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { assert, describe, expect } from 'vitest';

import type { LocalSession } from '@texra-ai/harness';
import { RunIdSchema, type RunId } from '@texra-ai/harness/schemas';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import type { SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import { slashCommands } from '@cli/chat/tui/commands/slashRegistry';
import { createChatSessionController } from '@cli/chat/chatSessionController';
import { EMPTY_DRAFT } from '@cli/chat/tui/input/draftAttachments';
import {
  patchSessionMeta,
  rootRunId,
  startChat,
} from '@cli/chat/tui/state/cliState';
import {
  bindSessionView,
  currentView,
  runViewOf,
} from '@cli/chat/tui/state/sessionView';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { notices } from '@cli/chat/tui/state/transcript';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import {
  answerOf,
  parkedRoot,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
  type StoredRow,
} from '@test/support/storeFaults';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';

/** The validation host's model, which its stored key makes available. */
const MODEL = 'openai/gpt-5.6-sol';

/** Done once `holds` reads true of the chat's signals (its state and the
 *  view it shows). */
const until = (holds: () => boolean): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const watched = computed(holds);
    if (watched.get()) return resume(Effect.void);
    const unsubscribe = subscribeToSignalChanges([watched], () => {
      if (!watched.get()) return;
      unsubscribe();
      resume(Effect.void);
    });
    return Effect.sync(unsubscribe);
  });

/** The chat's view of `runId`. */
const shown = (runId: RunId) => runViewOf(currentView(), runId);

/** The rows `runId`'s store holds of `type`. */
const rowsOf = (rows: readonly StoredRow[], runId: RunId, type: string) =>
  rows.filter((row) => row.run === runId && row.type === type);

/** The texts of `runId`'s model answers among `rows`, in order. */
const answersIn = (rows: readonly StoredRow[], runId: RunId) =>
  rows.flatMap((row) => {
    const text = row.run === runId ? answerOf(row) : null;
    return text === null ? [] : [text];
  });

/** The root runs the store holds: one per conversation started. */
const rootStarts = (storage: string) =>
  storedRows(storage).filter(
    (row) => row.type === 'run.start' && row.parent === null,
  );

/**
 * A conversation of the bundled `assistant` that answered and was stopped,
 * as one the person left: started on the session as a host starts it, then
 * stopped, so its view reads it cancelled and resumable.
 */
const stoppedConversation = (session: LocalSession) =>
  Effect.gen(function* () {
    const runId = yield* parkedRoot(yield* sessionHandleOf(session));
    yield* session.request({ kind: 'run.stop', runId, reason: 'user' });
    yield* session.view.changes.pipe(
      Stream.takeUntil((view) => {
        const run = view.runs.get(runId);
        return run?.outcome === 'cancelled' && run.holder !== 'here';
      }),
      Stream.runDrain,
    );
    return runId;
  });

/**
 * The chat over a persistent session of the test's host, as the chat entry
 * builds it: the session's view bound into the TUI's signal, a fresh
 * conversation on the bundled `assistant` and the validation model, and the
 * controller over its own chat and shutdown scopes, closed with the test.
 * `served`: the chat is a client of the background service.
 */
const openChat = (
  options: {
    readonly served?: boolean;
    readonly before?: (session: LocalSession) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const { roots } = yield* FakeHost;
    const session = yield* TestSession.open(roots, {
      persistent: true,
      host: {},
    });
    const runtime = yield* SessionGraph.runtime;
    const unbind = bindSessionView(runtime, {
      current: session.view.current,
      changes: session.view.changes,
    });
    yield* Effect.addFinalizer(() => Effect.sync(unbind));
    // A fresh conversation, which the test leaves behind fresh again: the
    // chat's state is the worker's, shared with the next suite.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        startChat();
        patchSessionMeta({ agent: 'assistant', model: MODEL });
      }),
      () => Effect.sync(() => startChat()),
    );
    const scope = () =>
      Effect.acquireRelease(Scope.make(), (made) =>
        Scope.close(made, Exit.void),
      );
    const tui = new TuiSession();
    const ctrl = createChatSessionController({
      session: tui,
      runSession: session,
      served: options.served ?? false,
      sessionContext: createTestCliContext({
        mode: 'interactive',
        approvalPolicy: 'ask',
        quietLogs: true,
        commandName: 'chat',
      }),
      chatScope: yield* scope(),
      shutdownScope: yield* scope(),
      cwd: roots.workspace ?? roots.storage,
      // cast: these plain messages match no slash command, so only the
      // empty table is read.
      getSlashCommandContext: () =>
        ({ commands: slashCommands([]) }) as SlashCommandContext,
      stores: roots,
      runtime,
      approvalPolicy: () => undefined,
      draft: yield* SubscriptionRef.make(EMPTY_DRAFT),
      modelConnection: { connected: Effect.void, open: Effect.succeed(false) },
    });
    return { session, tui, ctrl, storage: roots.storage };
  });

/** A message as the composer submits it. */
const typed = (text: string) => ({ ...EMPTY_DRAFT, text });

const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);

describe('createChatSessionController', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(texraHosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-chat-', TEXRA_APP), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'stops the resumed run for a Ctrl-C issued while its run is still rehydrating',
        () =>
          Effect.gen(function* () {
            const { session, tui, ctrl } = yield* openChat();
            const runId = yield* stoppedConversation(session);

            // The resume claims the launch at once: a Ctrl-C in the window
            // before the session holds the run lands on the resumed run.
            const resumed = yield* Effect.forkChild(ctrl.resume(runId), {
              startImmediately: true,
            });
            ctrl.stop('user');
            yield* Fiber.join(resumed);

            // The resume ended once the chat's view showed the run held;
            // the stop then ends it cancelled, and the chat exits as
            // interrupted.
            yield* until(() => shown(runId)?.outcome === 'cancelled');
            expect(shown(runId)?.holder).not.toBe('here');
            expect(tui.exitCode).toBe(CliExitCode.Interrupted);
          }),
      );

      it.effect(
        'a run that fails while the chat is leaving exits as a failure',
        () =>
          Effect.gen(function* () {
            // The quit does not make a failure a success: a run whose end
            // was lost exits as a failure, whether or not the chat is
            // leaving.
            const { session, tui, ctrl, storage } = yield* openChat();
            const runId = yield* stoppedConversation(session);
            const faults = yield* sessionStoreFaults(storage);
            yield* ctrl.resume(runId);
            // The user quits while the run still works; the store then
            // refuses the run's end.
            tui.exited = Promise.resolve(CliExitCode.Success);
            yield* faults.failNext('appendAll', 'run.end');
            ctrl.stop('shutdown');

            yield* until(() => shown(runId)?.holder !== 'here');
            expect(shown(runId)?.outcome).toBeNull();
            expect(tui.exitCode).toBe(CliExitCode.AgentError);
          }),
      );

      it.effect(
        'sends messages typed while a stop finishes to the stopped run in order, and the next to the stopped run',
        () =>
          Effect.gen(function* () {
            // Typed while the stop finishes: both go to the session's own
            // acceptance for that run, in order; the session waits for the
            // stop and continues the run. Once a stop has ended the run, a
            // later message still goes to it, so it cannot start a second
            // root beside it.
            const { ctrl, storage } = yield* openChat({ served: true });
            yield* ctrl.submit(typed('Start here.'));
            const root = rootRunId.get();
            assert(root !== undefined, 'the first message started no root');
            yield* until(() => shown(root)?.position === 'waiting');

            ctrl.stop('user');
            const first = yield* Effect.forkChild(
              ctrl.submit(typed('Do not drop this message.')),
              { startImmediately: true },
            );
            const second = yield* Effect.forkChild(
              ctrl.submit(typed('And this one.')),
              { startImmediately: true },
            );
            yield* Fiber.join(first);
            yield* Fiber.join(second);
            // Both answered: the run waits again, past its first turn.
            yield* until(() => {
              const run = shown(root);
              return run?.position === 'waiting' && (run.turn ?? 0) >= 2;
            });

            ctrl.stop('user');
            yield* until(() => {
              const run = shown(root);
              return (
                run?.outcome === 'cancelled' &&
                run.holder !== 'here' &&
                (run.turn ?? 0) >= 2
              );
            });
            yield* ctrl.submit(typed('Then this.'));
            expect(rootStarts(storage)).toHaveLength(1);

            yield* untilStored(storage, (rows) =>
              answersIn(rows, root).some((answer) =>
                answer.includes('Then this.'),
              ),
            );
            // The last answer saw every message, in the order typed, in
            // the one conversation.
            expect(answersIn(storedRows(storage), root).at(-1)).toBe(
              'Model saw: Start here. | Do not drop this message. | And this one. | Then this.',
            );
            expect(rootRunId.get()).toBe(root);
          }),
      );

      it.effect(
        'holds the launch until the view shows its run, for a stop and a message',
        () =>
          Effect.gen(function* () {
            // Until the session holds the first launch's run, the launch
            // is the chat's way to it: a stop and a message asked then
            // reach that run once it is held, instead of being lost or
            // starting a second root.
            const { tui, ctrl, storage } = yield* openChat({ served: true });
            const starting = yield* Effect.forkChild(
              ctrl.submit(typed('Start here.')),
              { startImmediately: true },
            );
            yield* until(() => tui.launched !== undefined);
            const messaging = yield* Effect.forkChild(
              ctrl.submit(typed('And then this.')),
              { startImmediately: true },
            );
            ctrl.stop('user');
            yield* Fiber.join(starting);
            yield* Fiber.join(messaging);
            const root = rootRunId.get();
            assert(root !== undefined, 'the launch reached no run');

            // Both reached the launch's run: the session recorded its stop
            // and queued the message on it.
            yield* untilStored(
              storage,
              (rows) =>
                rowsOf(rows, root, 'run.stop').length > 0 &&
                rowsOf(rows, root, 'followup.queued').some((row) =>
                  row.data.includes('And then this.'),
                ),
            );
            expect(rootStarts(storage)).toHaveLength(1);
          }),
      );

      it.effect(
        "exits as a failure when the root's result cannot be read",
        () =>
          Effect.gen(function* () {
            // The run's result fails (its end could not be stored): the
            // chat says so and exits as a failure.
            const { session, tui, ctrl, storage } = yield* openChat();
            const runId = yield* stoppedConversation(session);
            const faults = yield* sessionStoreFaults(storage);
            yield* ctrl.resume(runId);
            yield* faults.failNext('appendAll', 'run.end');
            ctrl.stop('user');

            yield* until(() =>
              notices.get().some((notice) => notice.row.kind === 'error'),
            );
            expect(tui.exitCode).toBe(CliExitCode.AgentError);
          }),
      );

      it.effect(
        'exits as a usage error when the task to resume is not found',
        () =>
          Effect.gen(function* () {
            const { tui, ctrl } = yield* openChat();
            yield* ctrl.resume(decodeRunId('aaaaaa'));

            expect(tui.exitCode).toBe(CliExitCode.Usage);
          }),
      );

      it.effect(
        'exits as a failure when the root is missing from the view',
        () =>
          Effect.gen(function* () {
            // The root's result arrives only once the view shows its end,
            // so a root the view no longer holds lost its end.
            const { tui } = yield* openChat();
            rootRunId.set(decodeRunId('a11111'));

            expect(tui.exitCode).toBe(CliExitCode.AgentError);
          }),
      );

      it.effect(
        "keeps a newer launch when the older root's result fails meanwhile",
        () =>
          Effect.gen(function* () {
            // Root A's result fails while the chat's next launch, B, is
            // still on its way: B is newer, so it still names its run when
            // it ends.
            const { tui } = yield* openChat();
            rootRunId.set(decodeRunId('a11111'));
            const launched = tui.claimLaunch();
            assert(launched !== undefined, 'no root is in flight');
            tui.rootFailed(decodeRunId('a11111'));
            tui.endLaunch(launched, { runId: decodeRunId('b22222') });

            expect(rootRunId.get()).toBe('b22222');
          }),
      );

      it.effect(
        "keeps a resume's run as the root when an earlier message's reply resumes the old one",
        () =>
          Effect.gen(function* () {
            // A message to the stopped root is still on its way when the
            // user resumes another conversation. The reply that the
            // session continued the old root lands while the resume is
            // launching: the resume is newer, so its run stays the chat's
            // root.
            const { session, ctrl, storage } = yield* openChat({
              served: true,
            });
            const picked = yield* stoppedConversation(session);
            yield* ctrl.submit(typed('Start here.'));
            const old = rootRunId.get();
            assert(old !== undefined, 'the first message started no root');
            yield* until(() => shown(old)?.position === 'waiting');
            ctrl.stop('user');
            yield* until(() => shown(old)?.outcome === 'cancelled');

            // The message's commit waits until the resume has claimed the
            // chat's launch, and the resume's read of its run waits until
            // the message's reply has landed: the reply comes while the
            // resume is launching.
            const faults = yield* sessionStoreFaults(storage);
            const commit = yield* faults.holdNext('appendAll');
            const sending = yield* Effect.forkChild(
              ctrl.submit(typed('Carry on.')),
              { startImmediately: true },
            );
            yield* commit.reached;
            const read = yield* faults.holdNext('readRunRecord');
            const resuming = yield* Effect.forkChild(ctrl.resume(picked), {
              startImmediately: true,
            });
            yield* read.reached;
            yield* commit.release;
            yield* Fiber.join(sending);
            yield* read.release;
            yield* Fiber.join(resuming);

            expect(rootRunId.get()).toBe(picked);
          }),
      );
    });
  });
});
