// Third-party imports
import { vscode } from '../vscode';
import type { z } from 'zod';

// Local imports

/**
 * Manages persistence of state for a single webview.
 */
export class WebviewStateManager<T extends Record<string, unknown>> {
  private defaultState: T;
  private state: T;

  constructor(
    defaultState: Partial<T> = {} as Partial<T>,
    schema?: z.ZodType<T>,
  ) {
    this.defaultState = { ...defaultState } as T;
    const saved = this.parseSavedState(vscode.getState(), schema);
    this.state = { ...this.defaultState, ...saved };
  }

  private parseSavedState(saved: unknown, schema?: z.ZodType<T>): Partial<T> {
    if (!saved) return {};
    if (!schema) return saved as Partial<T>;

    const result = schema.safeParse(saved);
    if (result.success) return result.data;

    console.warn(
      '[WebviewStateManager] Failed to parse saved state.',
      result.error,
    );
    return saved as Partial<T>;
  }

  getState(): T {
    return { ...this.state };
  }

  setState(state: T): void {
    this.state = { ...state };
    vscode.setState(this.state);
  }

  update(partial: Partial<T>): void {
    this.setState({ ...this.state, ...partial });
  }

  reset(): void {
    this.setState({ ...this.defaultState });
  }
}
