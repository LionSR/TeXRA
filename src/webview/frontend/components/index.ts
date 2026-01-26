/**
 * MainView components barrel export.
 *
 * Import all components to ensure they are registered with Lit.
 */

export { FileSelectGroup, type FileSelectConfig, type CheckboxValues } from './FileSelectGroup';
export { BannerGroup, type ApiKeyBannerState, type AgentConfigBannerState, type DependencyBannerState } from './BannerGroup';
export { LatexDiffsSection } from './LatexDiffsSection';
export {
  InstructionPanel,
  type SessionTypeChangeDetail,
  type AgentChangeDetail,
  type ModelChangeDetail,
  type InstructionChangeDetail,
  type ActionDetail,
} from './InstructionPanel';
export { OutputFilesSection } from './OutputFilesSection';
