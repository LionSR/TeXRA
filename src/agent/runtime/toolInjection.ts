import type { RegisteredToolName } from '@tools/registry';

/**
 * A tool that should be auto-injected into every tool-use agent's resolved
 * tool list when `shouldInject()` returns true. Used to keep agents from
 * having to opt into shared infrastructure (memory, goal) in YAML.
 *
 * Concrete features register one of these from the host's composition root
 * after `initPlatform()`. Core flow code iterates the registry — it doesn't
 * know which features are registered.
 */
interface ConditionalToolInjection {
  readonly toolName: RegisteredToolName;
  shouldInject(): boolean;
}

export class ToolInjectionRegistry {
  private readonly injections: ConditionalToolInjection[] = [];

  register(injection: ConditionalToolInjection): void {
    if (this.injections.some((i) => i.toolName === injection.toolName)) {
      throw new Error(
        `Duplicate conditional tool injection: ${injection.toolName}`,
      );
    }
    this.injections.push(injection);
  }

  list(): readonly ConditionalToolInjection[] {
    return [...this.injections];
  }
}

export const SharedToolInjectionRegistry = new ToolInjectionRegistry();
