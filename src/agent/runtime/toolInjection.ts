import type { RegisteredToolName } from '@tools/registry';

/**
 * A tool that should be auto-injected into every tool-use agent's resolved
 * tool list when `shouldInject()` returns true. Used to keep agents from
 * having to opt into shared infrastructure (memory, odyssey) in YAML.
 *
 * Concrete features register one of these from the host's composition root
 * after `initPlatform()`. Core flow code iterates the registry — it doesn't
 * know which features are registered.
 */
export interface ConditionalToolInjection {
  readonly toolName: RegisteredToolName;
  shouldInject(): boolean;
}

const injections: ConditionalToolInjection[] = [];

export function registerToolInjection(
  injection: ConditionalToolInjection,
): void {
  if (injections.some((i) => i.toolName === injection.toolName)) {
    throw new Error(
      `Duplicate conditional tool injection: ${injection.toolName}`,
    );
  }
  injections.push(injection);
}

export function listToolInjections(): readonly ConditionalToolInjection[] {
  return [...injections];
}

/** Test-only — clears the registry so suites don't leak across runs. */
export function __resetToolInjectionRegistry(): void {
  injections.length = 0;
}
