// Third-party imports
import * as vscode from 'vscode';

/**
 * A single command-to-handler binding for {@link registerCommands}.
 *
 * The handler keeps VS Code's native `registerCommand` signature
 * (`(...args: any[]) => any`) so value-returning handlers — whose results
 * flow back to `executeCommand` callers — are registered with their
 * semantics fully intact.
 */
interface CommandEntry {
  id: string;
  handler: (...args: any[]) => any;
}

/**
 * Register a list of commands and push their disposables onto the
 * extension's subscriptions in one call.
 *
 * This consolidates the repeated
 * `context.subscriptions.push(vscode.commands.registerCommand(id, handler), ...)`
 * boilerplate shared across the command modules. Handlers are registered
 * verbatim — no wrapping — so return values, argument lists, and each
 * handler's own error handling are preserved exactly.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  entries: readonly CommandEntry[],
): void {
  context.subscriptions.push(
    ...entries.map(({ id, handler }) =>
      vscode.commands.registerCommand(id, handler),
    ),
  );
}
