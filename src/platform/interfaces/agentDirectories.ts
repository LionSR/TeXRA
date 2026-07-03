/** Host-provided agent directory paths. */
export interface AgentDirectoriesPort {
  custom(): Promise<string>;
  builtIn(): Promise<string>;
  builtInToolUse(): Promise<string>;
}
