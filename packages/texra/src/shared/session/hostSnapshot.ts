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
  AgentConfigBannerDataSchema,
  AgentOptionDataSchema,
  DependencyBannerDataSchema,
  FileOptionsSchema,
  ModelOptionDataSchema,
  OnboardingFunnelStateSchema,
  TeamOptionDataSchema,
  WorkspaceRootOptionDataSchema,
} from '@shared/schemas';
import {
  TexraApprovalPolicySchema,
  TEXRA_APPROVAL_POLICY_DEFAULT,
} from '@shared/approvalPolicy';
import { getBasename } from '@utils/core';

const visible = { visible: z.boolean() };

/** How a project is named in a rail row, a chip, and the hero subtitle. */
const ProjectDisplaySchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  initials: z.string(),
  subtitle: z.string(),
});
export type ProjectDisplay = z.infer<typeof ProjectDisplaySchema>;

/** The display record of one open folder, produced by the host once so no
 *  renderer derives a name or initials from a path; the no-folder session
 *  reads as the prompt to open one. */
export function projectDisplayOf(
  key: string,
  root: string | undefined,
): ProjectDisplay {
  if (root === undefined) {
    return {
      key,
      name: 'No project open',
      initials: 'TX',
      subtitle: 'Open a folder to start',
    };
  }
  const base = getBasename(root);
  // The initials a rail row and the hero badge show for the folder.
  const initials = base
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');
  return {
    key,
    name: base || root,
    initials: initials || 'TX',
    subtitle: root,
  };
}

export const HostSnapshotSchema = z.object({
  project: ProjectDisplaySchema,
  /** Every agent; one that is also a document task carries its `rounds`. */
  agentOptions: z.array(AgentOptionDataSchema),
  modelOptions: z.array(ModelOptionDataSchema),
  teamOptions: z.array(TeamOptionDataSchema),
  workspaceRoots: z.array(WorkspaceRootOptionDataSchema),
  /** The project's configured policy, shown before a task is launched. */
  approvalPolicy: TexraApprovalPolicySchema,
  fileOptions: FileOptionsSchema,
  isGitRepo: z.boolean(),
  /** The one recorder per process and where its take is going. */
  recording: z.object({ session: z.string(), target: z.string() }).nullable(),
  /** The New-task state's notices; host-owned visibility. */
  banners: z.object({
    /** A credential that worked (a task has finished) stopped working;
     *  before a first task the "Connect a model" card is the prompt. */
    apiKey: z.object(visible),
    agentConfig: AgentConfigBannerDataSchema.extend(visible),
    dependency: DependencyBannerDataSchema.extend(visible),
    gettingStarted: z.boolean(),
    /** The background service this window's tasks run in went away, and
     *  the window is reaching it again. */
    serviceOffline: z.boolean(),
  }),
  onboarding: OnboardingFunnelStateSchema,
});
export type HostSnapshot = z.infer<typeof HostSnapshotSchema>;

export function emptyHostSnapshot(project: ProjectDisplay): HostSnapshot {
  return {
    project,
    agentOptions: [],
    modelOptions: [],
    teamOptions: [],
    workspaceRoots: [],
    approvalPolicy: TEXRA_APPROVAL_POLICY_DEFAULT,
    fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
    isGitRepo: false,
    recording: null,
    banners: {
      apiKey: { visible: false },
      agentConfig: { visible: false },
      dependency: { visible: false },
      gettingStarted: false,
      serviceOffline: false,
    },
    onboarding: 'done',
  };
}
