/** Configuration interface for controlling tool behavior and automation features. */
export interface ToolConfig {
  usePrefillFromInput: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  autoExtractTikzFigureReflect: boolean;
  attachTeXCount: boolean;
  autoConfirmation: boolean;
  printInputPrompt: boolean;
}
