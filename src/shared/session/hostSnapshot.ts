/**
 * The `host` snapshot the shell reads (PRD one-fold-three-renderers, 8.1):
 * host-provided data no surface may disagree about. A selection may differ
 * between two surfaces on one session; a catalog may not, so catalogs live
 * here and never in `Surface`. Components take it as a property; the root
 * receives it with the events frame (`sessionFrames.ts`), and the design
 * harness passes literals. Zod because it crosses the bridge.
 */
import { z } from 'zod';

import {
  AgentCategorySchema,
  AgentConfigBannerDataSchema,
  AgentOptionDataSchema,
  ApiKeyBannerDataSchema,
  DependencyBannerDataSchema,
  FileOptionsSchema,
  FileSelectConfigSchema,
  ModelOptionDataSchema,
  OnboardingFunnelStateSchema,
  TeamOptionDataSchema,
  WorkspaceRootOptionDataSchema,
} from '@shared/schemas';
import { getBasename } from '@utils/core';

const visible = { visible: z.boolean() };

/** How a paper is named in a rail row, a chip, and the hero subtitle. */
const PaperDisplaySchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  initials: z.string(),
  subtitle: z.string(),
});
export type PaperDisplay = z.infer<typeof PaperDisplaySchema>;

/** The initials a rail row and the hero badge show for a folder. */
function workspaceInitials(workspacePath: string | undefined): string {
  if (!workspacePath) return 'TX';
  const name = getBasename(workspacePath);
  if (!name) return 'TX';
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
  return initials || 'TX';
}

/** The display record of one open folder, produced by the host once so no
 *  renderer derives a name or initials from a path; the no-folder session
 *  reads as the prompt to open one. */
export function paperDisplayOf(
  key: string,
  root: string | undefined,
): PaperDisplay {
  if (root === undefined) {
    return {
      key,
      name: 'No paper open',
      initials: 'TX',
      subtitle: 'Open a folder to start',
    };
  }
  const name = getBasename(root) || root;
  return { key, name, initials: workspaceInitials(root), subtitle: root };
}

export const HostSnapshotSchema = z.object({
  paper: PaperDisplaySchema,
  /** Which view instance this is: the sidebar webview, the editor tab, or
   *  the desktop renderer. The sidebar alone reports `setActiveView`. */
  placement: z.enum(['sidebar', 'editor', 'desktop']),
  agentOptions: z.record(AgentCategorySchema, z.array(AgentOptionDataSchema)),
  modelOptions: z.array(ModelOptionDataSchema),
  teamOptions: z.array(TeamOptionDataSchema),
  workspaceRoots: z.array(WorkspaceRootOptionDataSchema),
  /** The launcher's multi-file groups (input, context, media). */
  fileConfigs: z.array(FileSelectConfigSchema),
  fileOptions: FileOptionsSchema,
  isGitRepo: z.boolean(),
  /** The one recorder per process and where its take is going. */
  recording: z.object({ session: z.string(), target: z.string() }).nullable(),
  debugMode: z.boolean(),
  /** The five banners of the New-task state; host-owned visibility. */
  banners: z.object({
    apiKey: ApiKeyBannerDataSchema.extend(visible),
    agentConfig: AgentConfigBannerDataSchema.extend(visible),
    dependency: DependencyBannerDataSchema.extend(visible),
    gettingStarted: z.boolean(),
    login: z.boolean(),
  }),
  onboarding: OnboardingFunnelStateSchema,
});
export type HostSnapshot = z.infer<typeof HostSnapshotSchema>;

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
    banners: {
      apiKey: { visible: false },
      agentConfig: { visible: false },
      dependency: { visible: false },
      gettingStarted: false,
      login: false,
    },
    onboarding: 'done',
  };
}
