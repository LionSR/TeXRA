// Public entry point for CLI dispatch helpers. Internal callers within the CLI
// area may import the focused modules under ./dispatch/ directly; this barrel
// keeps the stable import surface for command modules and tests.

export {
  reorderGlobalFlags,
  reorderNestedGlobalFlags,
  normalizeRootShortcuts,
  type NestedGlobalFlagGroup,
} from './dispatch/reorderFlags';

export {
  resolveDeepestSubCommand,
  type AnyCommand,
  type ResolvedCliCommand,
} from './dispatch/commandTree';

export {
  hasUsageNoColorFlag,
  setUsageColorOverrideFromRawArgs,
  withUsageSections,
  showUsage,
  showUsageStderr,
  type UsageSection,
} from './dispatch/usage';

export {
  detectUnknownCliCommand,
  formatUnknownCliCommand,
  type UnknownCliCommand,
} from './dispatch/unknownCommand';

export {
  detectUnknownCliFlag,
  formatUnknownCliFlag,
  type UnknownCliFlag,
} from './dispatch/unknownFlag';

export { isCliError } from './dispatch/cliError';
