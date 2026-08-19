import {
  CORE_LATEX_TOOLS,
  SUPPORTED_LATEX_COMPILERS,
} from '@shared/constants/latexToolchain';
import { checkToolInstalled } from '@utils/system/toolUtils';

// Kept in sync with @shared/constants/latex's CORE_LATEX_TOOLS SSOT: if one
// of these four names is renamed or removed there, this line fails to
// typecheck instead of silently drifting. The remaining doctor-only tools
// (compiler and bibliography alternates) have no equivalent in the
// setup-assistant probe, so they stay local to this file.
const SHARED_CORE_TOOLS = [
  'pdflatex',
  'latexmk',
  'latexindent',
  'latexdiff',
] as const satisfies readonly (typeof CORE_LATEX_TOOLS)[number][];

const DOCTOR_ONLY_TOOLS = ['xelatex', 'lualatex', 'bibtex', 'biber'] as const;

type LatexToolName =
  (typeof SHARED_CORE_TOOLS)[number] | (typeof DOCTOR_ONLY_TOOLS)[number];

interface LatexToolStatus {
  readonly name: LatexToolName;
  readonly installed: boolean;
  readonly required: boolean;
  readonly purpose: string;
}

export interface LatexToolchainProbe {
  readonly tools: readonly LatexToolStatus[];
  readonly hasCompiler: boolean;
}

const TOOL_PURPOSES: Record<LatexToolName, string> = {
  latexmk: 'LaTeX build orchestration',
  pdflatex: 'PDFLaTeX compiler',
  xelatex: 'XeLaTeX compiler',
  lualatex: 'LuaLaTeX compiler',
  bibtex: 'BibTeX bibliography processing',
  biber: 'Biber bibliography processing',
  latexdiff: 'LaTeX diff generation',
  latexindent: 'LaTeX formatting',
};

const REQUIRED_TOOLS = new Set<LatexToolName>(['latexmk']);

/** Probe the LaTeX tools used by both the extension and CLI surfaces. */
export async function probeLatexToolchain(): Promise<LatexToolchainProbe> {
  const toolNames = Object.keys(TOOL_PURPOSES) as LatexToolName[];
  const tools = await Promise.all(
    toolNames.map(async (name): Promise<LatexToolStatus> => ({
      name,
      installed: await checkToolInstalled(name, false),
      required: REQUIRED_TOOLS.has(name),
      purpose: TOOL_PURPOSES[name],
    })),
  );
  const installed = new Set(
    tools.filter((tool) => tool.installed).map((tool) => tool.name),
  );
  return {
    tools,
    hasCompiler: SUPPORTED_LATEX_COMPILERS.some((name) => installed.has(name)),
  };
}

/** Returns true when a compiler {@link compileLatex2Pdf} can drive is on PATH. */
export async function hasLatexCompiler(): Promise<boolean> {
  for (const tool of SUPPORTED_LATEX_COMPILERS) {
    if (await checkToolInstalled(tool, false)) return true;
  }
  return false;
}
