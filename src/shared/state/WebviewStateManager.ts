// Local imports
import { vscode } from '../vscode';

// Third-party imports
import type { z } from 'zod';

/**
 * Manages persistence of state for a single webview.
 * Wraps the VS Code `getState` and `setState` APIs.
 */
export class WebviewStateManager<T extends Record<string, unknown>> {
  private defaultState: T;
  private state: T;

  constructor(
    defaultState: Partial<T> = {} as Partial<T>,
    schema?: z.ZodType<T>,
  ) {
    this.defaultState = { ...defaultState } as T;
    const saved = vscode.getState();
    const parsed = schema?.safeParse(saved);
    this.state = parsed?.success
      ? { ...this.defaultState, ...parsed.data }
      : { ...this.defaultState };
  }

  /**
   * Returns a copy of the current state object.
   */
  getState(): T {
    return { ...this.state };
  }

  /**
   * Replaces the entire state and persists it via VS Code API.
   */
  setState(state: T): void {
    this.state = { ...state };
    vscode.setState(this.state);
  }

  /**
   * Applies partial updates to the state and persists the result.
   */
  update(partial: Partial<T>): void {
    this.setState({ ...this.state, ...partial });
  }

  /**
   * Resets state back to the provided defaults.
   */
  reset(): void {
    this.setState({ ...this.defaultState });
  }
}
