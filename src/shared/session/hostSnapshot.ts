/**
 * The `host` snapshot the shell reads (PRD one-fold-three-renderers, 8.1):
 * host-provided data no surface may disagree about. A selection may differ
 * between two surfaces on one session; a catalog may not, so catalogs live
 * here and never in `Surface`. Components take it as a property; the root
 * receives it with the frame, and the design harness passes literals.
 */
import type {
  AgentCategory,
  AgentOptionData,
  FileOptions,
  FileSelectConfig,
  ModelOptionData,
  TeamOptionData,
  WorkspaceRootOptionData,
} from '@shared/schemas';

/** How a paper is named in a rail row, a chip, and the hero subtitle. */
export interface PaperDisplay {
  readonly key: string;
  readonly name: string;
  readonly initials: string;
  readonly subtitle: string;
}

export interface HostSnapshot {
  readonly paper: PaperDisplay;
  /** Which view instance this is: the sidebar webview, the editor tab, or
   *  the desktop renderer. The sidebar alone reports `setActiveView`. */
  readonly placement: 'sidebar' | 'editor' | 'desktop';
  readonly agentOptions: Readonly<Record<AgentCategory, AgentOptionData[]>>;
  readonly modelOptions: readonly ModelOptionData[];
  readonly teamOptions: readonly TeamOptionData[];
  readonly workspaceRoots: readonly WorkspaceRootOptionData[];
  /** The launcher's multi-file groups (input, context, media). */
  readonly fileConfigs: readonly FileSelectConfig[];
  readonly fileOptions: FileOptions;
  readonly isGitRepo: boolean;
  /** The one recorder per process and where its take is going. */
  readonly recording: { session: string; target: string } | null;
  readonly debugMode: boolean;
}

export function emptyHostSnapshot(
  paper: PaperDisplay,
  placement: HostSnapshot['placement'] = 'sidebar',
): HostSnapshot {
  return {
    paper,
    placement,
    agentOptions: { toolUse: [], workflow: [] },
    modelOptions: [],
    teamOptions: [],
    workspaceRoots: [],
    fileConfigs: [],
    fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
    isGitRepo: false,
    recording: null,
    debugMode: false,
  };
}
