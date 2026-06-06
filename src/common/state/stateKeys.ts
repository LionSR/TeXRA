/**
 * Re-exports from `@shared/state/stateKeys`.
 *
 * The canonical home for these vscode-free enums is `@shared/state/stateKeys`.
 * This shim keeps the `@common/state` barrel working without changes and lets
 * any stray `@common/state/stateKeys` direct-imports continue to resolve.
 */
export {
  WorkspaceStateKey,
  GlobalStateKey,
  INSTRUCTION_PREFIX,
} from '@shared/state/stateKeys';
