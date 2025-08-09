// Common LaTeX tool names used across the system
export const TEX_TOOLS = ['latexdiff', 'latexindent', 'latexmk'] as const;

export type TexTool = (typeof TEX_TOOLS)[number];
