import { Effect } from 'effect';

import {
  DOCTOR_LATEX_TOOLS,
  SUPPORTED_LATEX_COMPILERS,
  type DoctorLatexTool,
} from '@shared/constants/latexToolchain';
import { checkToolInstalled } from '@utils/system/toolUtils';

type LatexToolStatus = DoctorLatexTool & { readonly installed: boolean };

export interface LatexToolchainProbe {
  readonly tools: readonly LatexToolStatus[];
  readonly hasCompiler: boolean;
}

/** Probe the LaTeX tools `texra doctor` reports on, in its row order. */
export const probeLatexToolchain = Effect.fn('latex.probeLatexToolchain')(
  function* (): Effect.fn.Return<LatexToolchainProbe> {
    const tools = yield* Effect.all(
      DOCTOR_LATEX_TOOLS.map((tool) =>
        Effect.map(
          checkToolInstalled(tool.name, false),
          (installed): LatexToolStatus => ({ ...tool, installed }),
        ),
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

/** Returns true when a compiler {@link compileLatex2Pdf} can drive is on PATH. */
export const hasLatexCompiler = Effect.fn('latex.hasLatexCompiler')(
  function* (): Effect.fn.Return<boolean> {
    for (const tool of SUPPORTED_LATEX_COMPILERS) {
      if (yield* checkToolInstalled(tool, false)) return true;
    }
    return false;
  },
);
