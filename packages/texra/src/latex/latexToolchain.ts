// Third-party imports
import { Effect } from 'effect';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Local imports
import {
  CORE_DEPENDENCY_TOOLS,
  DEPENDENCY_USE,
  HEALTH_LATEX_TOOLS,
  IMAGE_LATEX_TOOLS,
  LATEX_TOOL_ENTRIES,
  missingLatexTools,
  SUPPORTED_LATEX_COMPILERS,
  type HealthLatexTool,
  type LatexToolName,
} from '@texra/shared/constants/latexToolchain';
import type { MissingTool } from '@texra/shared/session/hostSnapshot';
import { findCommand } from '@texra/utils/system/binaryResolver';
import { probeTool } from '@texra/utils/system/toolChecks';

/** One catalog tool as this machine has it. */
interface LatexToolStatus<T extends LatexToolName> {
  readonly name: T;
  /** It answers its version probe, under its name or an alternate. */
  readonly installed: boolean;
  /** Where the lookup found it, when it did. */
  readonly path: string | undefined;
}

/** What {@link probeLatexTools} found, in the order the tools were asked. */
interface LatexToolchainProbe<T extends LatexToolName> {
  readonly tools: readonly LatexToolStatus<T>[];
  readonly installed: ReadonlySet<T>;
}

/**
 * Probe catalog tools: each one's version probe and its path, all at once.
 * The one probe of the LaTeX toolchain; the health report, the setup assistant,
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

/** One listed dependency as this machine has it. */
interface LatexToolHealth extends HealthLatexTool {
  readonly installed: boolean;
}

/** What {@link latexToolchainHealth} found. */
interface LatexToolchainHealth {
  /** A compiler `compileLatex2Pdf` can drive answers its probe: the
   *  settings view's TeX Distribution row reads the same set. */
  readonly compiler: boolean;
  /** Each dependency the report lists, in its row order. */
  readonly tools: readonly LatexToolHealth[];
}

/**
 * Whether this machine can build LaTeX: the compiler question and each
 * listed dependency, as data. A host words and paints it (`texra doctor`
 * prints a row per tool); a missing required tool is what fails the report.
 */
export const latexToolchainHealth = Effect.fn('latex.latexToolchainHealth')(
  function* (): Effect.fn.Return<
    LatexToolchainHealth,
    never,
    ChildProcessSpawner
  > {
    const { installed } = yield* probeLatexTools([
      ...new Set([
        ...SUPPORTED_LATEX_COMPILERS,
        ...HEALTH_LATEX_TOOLS.map((tool) => tool.name),
      ]),
    ]);
    return {
      compiler: SUPPORTED_LATEX_COMPILERS.some((name) => installed.has(name)),
      tools: HEALTH_LATEX_TOOLS.map((tool) => ({
        ...tool,
        installed: installed.has(tool.name),
      })),
    };
  },
);

/**
 * The tools TeXRA's features need that this machine lacks (latexindent,
 * Perl, Ghostscript, GraphicsMagick or ImageMagick), as the dependency
 * banner lists them. Every probe answers `false` rather than failing, so
 * this has no failure of its own to mask; the banner is what tells the user.
 */
export const missingDependencyTools = Effect.fn('latex.missingDependencyTools')(
  function* (): Effect.fn.Return<MissingTool[], never, ChildProcessSpawner> {
    const { tools } = yield* probeLatexTools([
      ...CORE_DEPENDENCY_TOOLS,
      ...IMAGE_LATEX_TOOLS,
    ]);
    return missingLatexTools(tools).map(({ name, interchangeable }) => ({
      label: LATEX_TOOL_ENTRIES[name].label ?? name,
      interchangeable,
      usedFor: DEPENDENCY_USE[name],
    }));
  },
);
