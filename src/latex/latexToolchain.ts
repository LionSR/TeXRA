import { checkToolInstalled } from '@utils/system/toolUtils';

export type LatexToolName =
  | 'latexmk'
  | 'pdflatex'
  | 'xelatex'
  | 'lualatex'
  | 'bibtex'
  | 'biber'
  | 'latexdiff'
  | 'latexindent';

export interface LatexToolStatus {
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

export const LATEX_TOOLCHAIN_TOOLS: readonly LatexToolName[] = [
  'latexmk',
  'pdflatex',
  'xelatex',
  'lualatex',
  'bibtex',
  'biber',
  'latexdiff',
  'latexindent',
];

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
  const installed = await Promise.all(
    LATEX_TOOLCHAIN_TOOLS.map((tool) => checkToolInstalled(tool, false)),
  );
  const tools = LATEX_TOOLCHAIN_TOOLS.map((name, index): LatexToolStatus => {
    return {
      name,
      installed: installed[index] ?? false,
      required: REQUIRED_TOOLS.has(name),
      purpose: TOOL_PURPOSES[name],
    };
  });
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
