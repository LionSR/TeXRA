import type { IModelHandler } from '@agent/types/IModelHandler';
import type {
  ModelCredentialRoute,
  ModelCredentialSelection,
  SdkToolCall,
} from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';

/** The model-handler shape every flow drives, parameterized by SDK client. */
export type RunModelHandler<C = unknown> = IModelHandler<
  ProviderMessage,
  unknown,
  SdkToolCall,
  C
>;

/**
 * The run's live (handler, model id, provider client) triple, held in one
 * shared object.
 *
 * A run's services bag is assembled by spreading the launch context, so a bare
 * `modelHandler` field is copied by value and a mid-run switch has to be
 * mirrored into every copy. Passing this cell instead keeps one reference:
 * readers see the pair the run is actually using, and a switch is a single
 * {@link swap}. Handler and model id move together, so no reader can observe a
 * handler from one model paired with another model's id.
 *
 * The provider client lives here for the same reason. {@link getClient} builds
 * it once and reuses it until the credential changes ({@link rebind}) or the
 * handler does ({@link swap}); readers await it instead of holding a copy, so a
 * relay-401 rebind is visible to the next read rather than being shadowed by a
 * client the refresh already retired.
 *
 * Disposal: the cell owns every handler it holds. `swap` disposes the handler
 * it retires and {@link dispose} disposes the one still live at end of run, so
 * each handler is disposed exactly once by one owner.
 */
export class ModelCell<C = unknown> {
  #handler: RunModelHandler<C>;
  #modelId: string;
  /**
   * Boxed so a built client is distinguishable from "not built yet" even for a
   * handler whose client type admits `undefined`.
   */
  #current: { readonly client: C } | undefined;
  #building: Promise<C> | undefined;
  /** The handler a pending #building belongs to, so a build retired by a
   *  mid-flight swap can neither publish its client nor clear a successor's
   *  registration. */
  #buildingFor: RunModelHandler<C> | undefined;

  constructor(handler: RunModelHandler<C>, modelId: string) {
    this.#handler = handler;
    this.#modelId = modelId;
  }

  get handler(): RunModelHandler<C> {
    return this.#handler;
  }

  get modelId(): string {
    return this.#modelId;
  }

  /** Credential route the client this cell holds captured, if it has one. */
  get route(): ModelCredentialRoute | undefined {
    return this.#current
      ? this.#handler.getCredentialRouteForClient(this.#current.client)
      : undefined;
  }

  /** The provider client for the live handler, built on first read. */
  async getClient(): Promise<C> {
    if (this.#current) return this.#current.client;
    if (!this.#building) {
      this.#buildingFor = this.#handler;
      this.#building = this.#buildClient(this.#handler);
    }
    return this.#building;
  }

  async #buildClient(builtFor: RunModelHandler<C>): Promise<C> {
    try {
      const client = await builtFor.getClient();
      // A swap may have retired builtFor while its build was in flight; the
      // caller that started the build still gets its client, but the cell
      // must not pair it with the replacement handler.
      if (this.#handler === builtFor) {
        this.#current = { client };
      }
      return client;
    } finally {
      if (this.#buildingFor === builtFor) {
        this.#building = undefined;
        this.#buildingFor = undefined;
      }
    }
  }

  /**
   * Rebuild the client for an explicit credential selection: after a relay
   * token rotation, or a manual retry the user may have preceded with a new
   * API key.
   *
   * The replacement is published only once it exists and cancellation has not
   * won, so a failed or cancelled rebind leaves the run on the client it is
   * already using.
   */
  async rebind(
    selection: ModelCredentialSelection = 'configured',
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const rebindFor = this.#handler;
    const replacement = await rebindFor.refreshClient(selection);
    signal?.throwIfAborted();
    // Same retirement guard as #buildClient: a swap that landed while the
    // refresh was in flight owns the cell now.
    if (this.#handler !== rebindFor) return;
    this.#current = { client: replacement };
    this.#building = undefined;
    this.#buildingFor = undefined;
  }

  /** Adopt a new pair and dispose the handler it replaces. */
  swap(handler: RunModelHandler<C>, modelId: string): void {
    const retired = this.#handler;
    this.#handler = handler;
    this.#modelId = modelId;
    // The retired handler owns the client it built, so the next read builds
    // one from the handler now live.
    this.#current = undefined;
    this.#building = undefined;
    this.#buildingFor = undefined;
    if (retired !== handler) retired.dispose();
  }

  dispose(): void {
    this.#handler.dispose();
  }
}
