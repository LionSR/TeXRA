import { CORE_LATEX_TOOLS } from '@shared/constants/latex';
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
  readonly hasBibliographyTool: boolean;
  readonly hasLatexmk: boolean;
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

const COMPILER_TOOLS: readonly LatexToolName[] = [
  'latexmk',
  'pdflatex',
  'xelatex',
  'lualatex',
];

const REQUIRED_TOOLS = new Set<LatexToolName>(['latexmk']);

/** Probe the LaTeX tools used by both the extension and CLI surfaces. */
export async function probeLatexToolchain(): Promise<LatexToolchainProbe> {
  const toolNames = Object.keys(TOOL_PURPOSES) as LatexToolName[];
  const installed = await Promise.all(
    toolNames.map((tool) => checkToolInstalled(tool, false)),
  );
  const tools = toolNames.map((name, index): LatexToolStatus => ({
    name,
    installed: installed[index] ?? false,
    required: REQUIRED_TOOLS.has(name),
    purpose: TOOL_PURPOSES[name],
  }));
  return {
    tools,
    hasCompiler: tools.some(
      (tool) => tool.installed && COMPILER_TOOLS.includes(tool.name),
    ),
    hasBibliographyTool: tools.some(
      (tool) =>
        tool.installed && (tool.name === 'bibtex' || tool.name === 'biber'),
    ),
    hasLatexmk: tools.some((tool) => tool.name === 'latexmk' && tool.installed),
  };
}

/** Returns true when a supported LaTeX-to-PDF compiler is available. */
export async function hasLatexCompiler(): Promise<boolean> {
  for (const tool of COMPILER_TOOLS) {
    if (await checkToolInstalled(tool, false)) return true;
  }
  return false;
}
