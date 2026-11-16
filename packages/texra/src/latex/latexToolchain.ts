// Third-party imports
import { Effect } from 'effect';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Local imports
import type { LatexToolName } from '@texra/shared/constants/latexToolchain';
import { findCommand } from '@texra/utils/system/binaryResolver';
import { probeTool } from '@texra/utils/system/toolChecks';

/** One catalog tool as this machine has it. */
export interface LatexToolStatus<T extends LatexToolName> {
  readonly name: T;
  /** It answers its version probe, under its name or an alternate. */
  readonly installed: boolean;
  /** Where the lookup found it, when it did. */
  readonly path: string | undefined;
}

/** What {@link probeLatexTools} found, in the order the tools were asked. */
export interface LatexToolchainProbe<T extends LatexToolName> {
  readonly tools: readonly LatexToolStatus<T>[];
  readonly installed: ReadonlySet<T>;
}

/**
 * Probe catalog tools: each one's version probe and its path, all at once.
 * The one probe of the LaTeX toolchain; `texra doctor`, the setup assistant,
 * the settings view's LaTeX tab and the dependency banner each read the
 * tools they report from it. Every call spawns, so a surface reports what is
 * installed now; interrupting it kills the spawned probes.
 */
export function probeLatexTools<T extends LatexToolName>(
  names: readonly T[],
): Effect.Effect<LatexToolchainProbe<T>, never, ChildProcessSpawner> {
  return Effect.all(
    names.map((name) =>
      Effect.gen(function* () {
        const installed = yield* probeTool(name);
        const found = yield* findCommand(name);
        const status: LatexToolStatus<T> = {
          name,
          installed,
          path: found?.resolvedPath,
        };
        return status;
      }),
    ),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map((tools) => ({
      tools,
      installed: new Set(
        tools.filter((tool) => tool.installed).map((tool) => tool.name),
      ),
    })),
    Effect.withSpan('latex.probeLatexTools'),
  );
}
