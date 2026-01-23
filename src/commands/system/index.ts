// Barrel export for system commands
export { helpCommands, registerHelpCommands } from './helpCommands';
export { mainViewCommands, registerMainViewCommands } from './mainViewCommands';
export {
  sampleProjectCommands,
  registerSampleProjectCommands,
} from './sampleProjectCommands';
export { settingsCommands, registerSettingsCommands } from './settingsCommands';
export { registerTestCommands } from './testCommands';
export { registerTextEditorCommands } from './textEditorCommands';
export {
  walkthroughCommands,
  registerWalkthroughCommands,
} from './walkthroughCommands';
export {
  xmlCommands,
  handleParseXml,
  handleValidateAndFixXml,
  registerXmlCommands,
} from './xmlCommands';
export {
  yamlCommands,
  handleTestAgentLoading,
  handleLoadSpecificAgent,
  handleParseYaml,
  registerYamlCommands,
} from './yamlCommands';
