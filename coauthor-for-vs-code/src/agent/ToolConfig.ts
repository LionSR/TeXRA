/** Configuration interface for controlling tool behavior and automation features. */
export interface ToolConfig {
  usePrefillFromInput: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  autoExtractTikzFigureReflect: boolean;
  includeTexCount: boolean;
  autoConfirmation: boolean;
  printInputPrompt: boolean;
  useOpenRouter: boolean;
}
