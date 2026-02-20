/**
 * Context-local workspace root override via AsyncLocalStorage.
 *
 * When a tool-use agent runs in a git worktree, runToolUseFlow wraps the
 * entire flow in {@link workspaceRootStorage}.run(worktreePath, fn).
 * {@link WorkspaceFS} checks this before falling back to the VS Code workspace.
 *
 * AsyncLocalStorage propagates through async/await chains automatically
 * and is safe for concurrent agents with different roots.
 */

// Standard library imports
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Holds the workspace root override for the current async execution context.
 * When set, {@link WorkspaceFS} uses this path instead of the VS Code workspace.
 */
export const workspaceRootStorage = new AsyncLocalStorage<string>();
