/**
 * Base flow context providing shared lazy initialization pattern.
 *
 * Both ToolUseFlowContext and ReflectionFlowContext follow the same pattern:
 * 1. Store init config in a protected readonly field
 * 2. Have a nullable _services field for caching
 * 3. Provide a services getter that builds and caches services
 *
 * This base class encapsulates this pattern, reducing duplication and
 * ensuring consistent behavior across flow contexts.
 *
 * ## Usage:
 *
 * ```typescript
 * class MyFlowContext extends BaseFlowContext<MyInit, MyServices, MyClient> {
 *   protected buildFlowSpecificServices(): Omit<MyServices, keyof BaseFlowServices<MyClient>> {
 *     return {
 *       myService: this.createMyService(),
 *       // ... other flow-specific services
 *     };
 *   }
 * }
 * ```
 */

import type { BaseFlowContextInit, BaseFlowServices } from './BaseFlowServices';
import { buildBaseFlowServices } from './BaseFlowServices';

/**
 * Abstract base class for flow contexts.
 *
 * Provides:
 * - Protected access to initialization config via `this.init`
 * - Lazy-cached services via `this.services` getter
 * - Abstract method for building flow-specific services
 *
 * @template InitT - The initialization config type (extends BaseFlowContextInit)
 * @template ServicesT - The services interface type (extends BaseFlowServices)
 * @template C - The API client type
 */
export abstract class BaseFlowContext<
  InitT extends BaseFlowContextInit<C>,
  ServicesT extends BaseFlowServices<C>,
  C = unknown,
> {
  protected readonly init: InitT;
  private _services: ServicesT | null = null;

  constructor(init: InitT) {
    this.init = init;
  }

  /**
   * Get the services for this flow context.
   *
   * Services are built lazily on first access and cached for subsequent calls.
   * The base services are built from init, then flow-specific services are added.
   */
  get services(): ServicesT {
    if (this._services) {
      return this._services;
    }

    // Build base services shared by all flows
    const baseServices = buildBaseFlowServices(this.init);

    // Build flow-specific services and merge with base
    this._services = {
      ...baseServices,
      ...this.buildFlowSpecificServices(),
    } as ServicesT;

    return this._services;
  }

  /**
   * Build flow-specific services.
   *
   * Subclasses implement this to provide their specialized services.
   * The returned object is spread into the base services.
   *
   * @returns Object containing flow-specific services
   */
  protected abstract buildFlowSpecificServices(): Partial<ServicesT>;
}
