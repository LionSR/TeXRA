/** Configuration interface for controlling tool behavior and automation features. */
export interface ToolConfig {
  reflect: boolean;
  usePrefillFromInput: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  attachTeXCount: boolean;
  printInputPrompt: boolean;
  autoCompileInputPdf: boolean;
}
