import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

/**
 * Host-injected linter diagnostics provider, consumed by the diagnostics
 * tool's `list`/`count` commands. Hosts without a linter integration (CLI,
 * desktop) return an empty array.
 */
export type LinterProvider = (path: string) => Promise<GenericDiagnostic[]>;
