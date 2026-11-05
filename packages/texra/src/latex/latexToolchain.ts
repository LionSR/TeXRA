import { Effect } from 'effect';

import {
  DOCTOR_LATEX_TOOLS,
  SUPPORTED_LATEX_COMPILERS,
  type DoctorLatexTool,
} from '@texra/shared/constants/latexToolchain';
import { probeTool } from '@texra/utils/system/toolChecks';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

type LatexToolStatus = DoctorLatexTool & { readonly installed: boolean };

interface LatexToolchainProbe {
  readonly tools: readonly LatexToolStatus[];
  readonly hasCompiler: boolean;
}

/** Probe the LaTeX tools `texra doctor` reports on, in its row order. */
export const probeLatexToolchain = Effect.fn('latex.probeLatexToolchain')(
  function* (): Effect.fn.Return<
    LatexToolchainProbe,
    never,
    ChildProcessSpawner
  > {
    const tools = yield* Effect.all(
      DOCTOR_LATEX_TOOLS.map((tool) =>
        Effect.map(probeTool(tool.name), (installed): LatexToolStatus => ({
          ...tool,
          installed,
        })),
      ),
      { concurrency: 'unbounded' },
    );
    const installed = new Set(
      tools.filter((tool) => tool.installed).map((tool) => tool.name),
    );
    return {
      tools,
      hasCompiler: SUPPORTED_LATEX_COMPILERS.some((name) =>
        installed.has(name),
      ),
    };
  },
);
