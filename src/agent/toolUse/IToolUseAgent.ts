export interface IToolUseAgent<ErrorType> {
  setConfiguredTools(tools: string[]): void;
  fixIssues(filePath: string): Promise<boolean>;
}
