import { Cause, Effect, Exit, Result } from 'effect';

import { hostPort } from '@common/hostPort';
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

/**
 * Re-raise a memory failure as the cause the filesystem or host prompt
 * raised. The memory path has no recovery above
 * this point — the previous `await` chain let the same error reach the host's
 * own error handling — so the host edge's `runPromise` rejects with that
 * instance rather than with a tagged wrapper nobody reads. Compound failures
 * are reported together, with their complete Cause retained on the error.
 */
function raiseCause<A, E extends { readonly cause: unknown }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, never, R> {
  return Effect.catchCause(effect, (cause) => {
    const unwrapped = Cause.map(cause, (error) => error.cause);
    if (unwrapped.reasons.length > 1 && !Cause.hasInterruptsOnly(unwrapped)) {
      return Effect.die(
        new Error(Cause.pretty(unwrapped), { cause: unwrapped }),
      );
    }
    const error = Cause.findError(unwrapped);
    return Result.isFailure(error)
      ? Effect.failCause(error.failure)
      : Effect.die(error.success);
  });
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
      yield* hostPort(() => this.post(message, respond)).pipe(Effect.orDie);
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
        // Unwrap only memory failures; response errors keep their own cause.
        raiseCause(
          this.memoryController.getMemoryPreviewMessage(data.storagePath),
        ).pipe(
          Effect.flatMap((message) =>
            hostPort(() => this.post(message, options.respond)),
          ),
        ),
      );
      if (Exit.isSuccess(posted)) return;
      yield* hostPort(() => options.onError?.(Cause.squash(posted.cause))).pipe(
        Effect.orDie,
      );
      yield* hostPort(() =>
        this.post(
          this.memoryController.getMemoryPreviewErrorMessage(data.storagePath),
          options.respond,
        ),
      ).pipe(Effect.orDie);
    },
  );

  readonly deleteMemory = Effect.fn('SettingsViewHost.deleteMemory')(function* (
    this: SettingsViewHost,
    data: Pick<MemoryDeleteMessage, 'displayPath' | 'storagePath'>,
    respond?: SettingsRespond,
  ) {
    const message = yield* raiseCause(this.memoryController.deleteMemory(data));
    if (message == null) return;
    yield* hostPort(() => this.post(message, respond)).pipe(Effect.orDie);
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
      if (message == null) return;
      yield* hostPort(() => this.post(message, respond)).pipe(Effect.orDie);
    },
  );

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
}
