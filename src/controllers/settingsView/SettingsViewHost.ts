import { Cause, Data, Effect, Exit } from 'effect';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsMessageFor, SETTINGS_VIEW_CMD } from '@shared/schemas';
import type {
  SettingsRespond,
  SettingsStatePorts,
} from '@shared/settingsView/types';

import { SettingsMemoryController } from './SettingsMemoryController';
import { SettingsModelSelectionController } from './SettingsModelSelectionController';

type Awaitable<T> = T | PromiseLike<T>;
type MemoryControllerOptions = ConstructorParameters<
  typeof SettingsMemoryController
>[0];
type MemoryPreviewMessage = SettingsMessageFor<
  typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW
>;
type MemoryDeleteMessage = SettingsMessageFor<
  typeof SETTINGS_VIEW_CMD.DELETE_MEMORY
>;
type SetModelEnabledInput = Omit<
  SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED>,
  'command'
>;
type SetReasoningLevelInput = Omit<
  SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL>,
  'command'
>;
interface SettingsViewHostOptions {
  readonly state: SettingsStatePorts;
  readonly memoryPrompt: MemoryControllerOptions['prompt'];
  readonly respond?: SettingsRespond;
  readonly controllers?: {
    readonly modelSelection?: SettingsModelSelectionController;
  };
}

/** The view's `respond` callback rejected while posting a memory message. */
class SettingsPostFailed extends Data.TaggedError('SettingsPostFailed')<{
  readonly cause: unknown;
}> {}

/**
 * Re-raise a memory failure as the cause the filesystem, the host prompt, or
 * the view's respond callback raised. The memory path has no recovery above
 * this point — the previous `await` chain let the same error reach the host's
 * own error handling — so the host edge's `runPromise` rejects with that
 * instance rather than with a tagged wrapper nobody reads.
 */
function raiseCause<A, E extends { readonly cause: unknown }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, never, R> {
  return Effect.catch(effect, (error) => Effect.die(error.cause));
}

interface SettingsViewHostMutationOptions {
  readonly afterPost?: () => Awaitable<void>;
  readonly respond?: SettingsRespond;
}

export class SettingsViewHost {
  readonly memoryController: SettingsMemoryController;
  readonly modelSelectionController: SettingsModelSelectionController;

  constructor(private readonly options: SettingsViewHostOptions) {
    this.memoryController = new SettingsMemoryController({
      prompt: options.memoryPrompt,
    });
    this.modelSelectionController =
      options.controllers?.modelSelection ??
      new SettingsModelSelectionController({
        globalState: options.state.globalState,
      });
  }

  readonly sendMemoryData = Effect.fn('SettingsViewHost.sendMemoryData')(
    function* (this: SettingsViewHost, respond?: SettingsRespond) {
      const message = yield* raiseCause(
        this.memoryController.getMemoryDataMessage(),
      );
      yield* raiseCause(this.postToRespond(message, respond));
    },
  );

  /**
   * Post one memory preview, or the preview's error placeholder when it
   * cannot be produced. Every outcome of the read-and-post — an unreadable
   * file, a rejected post, a defect — is reported through `onError` and then
   * answered with the placeholder, so the view never waits on a preview that
   * will not arrive.
   */
  readonly sendMemoryPreview = Effect.fn('SettingsViewHost.sendMemoryPreview')(
    function* (
      this: SettingsViewHost,
      data: Pick<MemoryPreviewMessage, 'storagePath'>,
      options: {
        readonly respond?: SettingsRespond;
        readonly onError?: (error: unknown) => Awaitable<void>;
      } = {},
    ) {
      const posted = yield* Effect.exit(
        this.memoryController.getMemoryPreviewMessage(data.storagePath).pipe(
          Effect.flatMap((message) =>
            this.postToRespond(message, options.respond),
          ),
          // Report the filesystem or post error itself, not the tag that
          // carried it: `Data.TaggedError`'s `message` is the tag string,
          // and the extension formats whatever reaches `onError` with
          // `toErrorMessage`. Unwrapping in the failure channel (rather
          // than after `Cause.squash`) keeps a defect untouched, and is
          // the same contract `raiseCause` gives the sibling methods.
          Effect.catch((error) => Effect.fail(error.cause)),
        ),
      );
      if (Exit.isSuccess(posted)) return;
      yield* raiseCause(
        Effect.tryPromise({
          try: async () => {
            await options.onError?.(Cause.squash(posted.cause));
          },
          catch: (cause) => new SettingsPostFailed({ cause }),
        }),
      );
      yield* raiseCause(
        this.postToRespond(
          this.memoryController.getMemoryPreviewErrorMessage(data.storagePath),
          options.respond,
        ),
      );
    },
  );

  readonly deleteMemory = Effect.fn('SettingsViewHost.deleteMemory')(function* (
    this: SettingsViewHost,
    data: Pick<MemoryDeleteMessage, 'displayPath' | 'storagePath'>,
    respond?: SettingsRespond,
  ) {
    const message = yield* raiseCause(this.memoryController.deleteMemory(data));
    yield* raiseCause(this.postMaybeToRespond(message, respond));
  });

  readonly setMemoryPinned = Effect.fn('SettingsViewHost.setMemoryPinned')(
    function* (
      this: SettingsViewHost,
      storagePath: string,
      pinned: boolean,
      respond?: SettingsRespond,
    ) {
      const message = yield* raiseCause(
        this.memoryController.setMemoryPinned(storagePath, pinned),
      );
      yield* raiseCause(this.postMaybeToRespond(message, respond));
    },
  );

  /**
   * The memory path's one wrap of the still-Promise post helpers below, which
   * the model-selection methods share. A rejected `respond` is a tagged
   * failure here so the memory programs can compose it; `raiseCause` turns it
   * back into the host's own error at the surface.
   */
  private postToRespond(
    message: unknown,
    respond?: SettingsRespond,
  ): Effect.Effect<void, SettingsPostFailed> {
    return Effect.tryPromise({
      try: () => this.post(message, respond),
      catch: (cause) => new SettingsPostFailed({ cause }),
    });
  }

  private postMaybeToRespond(
    message: unknown | null | undefined,
    respond?: SettingsRespond,
  ): Effect.Effect<void, SettingsPostFailed> {
    return Effect.tryPromise({
      try: () => this.postMaybe(message, respond),
      catch: (cause) => new SettingsPostFailed({ cause }),
    });
  }

  async sendModelSelectionData(respond?: SettingsRespond): Promise<void> {
    await this.post(
      await this.modelSelectionController.buildModelSelectionMessage(),
      respond,
    );
  }

  async setModelEnabled(
    input: SetModelEnabledInput,
    options?: SettingsViewHostMutationOptions,
  ): Promise<void> {
    await this.modelSelectionController.setModelEnabled(input);
    await this.postModelSelectionMutation(options);
  }

  async setReasoningLevel(
    input: SetReasoningLevelInput,
    options?: SettingsViewHostMutationOptions,
  ): Promise<void> {
    await this.modelSelectionController.setReasoningLevel(input);
    await this.postModelSelectionMutation(options);
  }

  private async postModelSelectionMutation(
    options?: SettingsViewHostMutationOptions,
  ): Promise<void> {
    await this.sendModelSelectionData(options?.respond);
    await options?.afterPost?.();
  }

  private async post(
    message: unknown,
    respond = this.options.respond,
  ): Promise<void> {
    if (!respond) {
      throw new Error('SettingsViewHost has no response target.');
    }
    await respond(message);
  }

  private async postMaybe(
    message: unknown | null | undefined,
    respond?: SettingsRespond,
  ): Promise<void> {
    if (message == null) return;
    await this.post(message, respond);
  }
}
