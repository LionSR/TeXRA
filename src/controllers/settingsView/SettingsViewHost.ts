import { Cause, Effect, Exit } from 'effect';

import { hostPort } from '@common/hostPort';
import type { PlatformSecrets } from '@platform/secrets';
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
  /**
   * Provider credentials behind the model picker's availability decoration.
   * `SettingsStatePorts` carries only the two state stores, so the secret
   * store rides on the host options and is threaded from each host's root.
   */
  readonly secrets: PlatformSecrets;
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
        secrets: options.secrets,
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
        this.memoryController.getMemoryPreviewMessage(data.storagePath).pipe(
          // Unwrap only the memory failure; hostPort preserves the response
          // error itself, including an error that has its own cause field.
          Effect.catch((error) => Effect.fail(error.cause)),
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
