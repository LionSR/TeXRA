/**
 * The `host` snapshot the shell reads (PRD one-fold-three-renderers, 8.1):
 * host-provided data no surface may disagree about. A selection may differ
 * between two surfaces on one session; a catalog may not, so catalogs live
 * here and never in `Surface`. Components take it as a property; the root
 * receives it with the events frame (`sessionFrames.ts`), and the design
 * harness passes literals. Zod because it crosses the bridge.
 */
import {
  getBasename,
  ModelOptionDataSchema,
  TeamOptionDataSchema,
  ApprovalPolicySchema,
  APPROVAL_POLICY_DEFAULT,
} from '@texra-ai/harness/schemas';
import { z } from 'zod';

import { DocumentAgentOptionSchema } from '@texra/shared/plugins/documents';

const visible = { visible: z.boolean() };

/** Open workspace folder offered as a run working directory. */
const WorkspaceRootOptionDataSchema = z.object({
  value: z.string(),
  label: z.string(),
});

const AgentConfigBannerDataSchema = z.object({
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});

/**
 * One missing dependency as the host reports it: already labeled for
 * display, and marked when another entry in the same list satisfies the same
 * requirement (GraphicsMagick vs ImageMagick) — the wire carries that
 * choose-one fact so no renderer has to decode it from an id.
 */
const MissingToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  interchangeable: z.boolean(),
  /** What TeXRA can't do without it, completing "TeXRA can't …". */
  usedFor: z.string(),
});
export type MissingTool = z.infer<typeof MissingToolSchema>;

const DependencyBannerDataSchema = z.object({
  missingTools: z.array(MissingToolSchema).nullish(),
});

const FileOptionsSchema = z.object({
  baseFile: z.array(z.string()),
  editedFile: z.array(z.string()),
  commit: z.array(z.string()),
});
export type FileOptions = z.infer<typeof FileOptionsSchema>;

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

/**
 * Where the onboarding funnel stands (PRD: agent-native onboarding): the
 * state hosts push to webviews. `onboardingFunnel.ts` derives it.
 */
const OnboardingFunnelStateSchema = z.enum([
  'needs-credential',
  'setup',
  'done',
]);
export type OnboardingFunnelState = z.infer<typeof OnboardingFunnelStateSchema>;

export const HostSnapshotSchema = z.object({
  project: ProjectDisplaySchema,
  /** Every agent; one that is also a document task carries its `rounds`. */
  agentOptions: z.array(DocumentAgentOptionSchema),
  modelOptions: z.array(ModelOptionDataSchema),
  teamOptions: z.array(TeamOptionDataSchema),
  workspaceRoots: z.array(WorkspaceRootOptionDataSchema),
  /** The project's configured policy, shown before a task is launched. */
  approvalPolicy: ApprovalPolicySchema,
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
    /** Why the background service this window's tasks run in is out of
     *  reach (it went away and the window is reaching it again, or a newer
     *  TeXRA's service refused this window); null while it is reached. */
    serviceOffline: z.string().nullable(),
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
    approvalPolicy: APPROVAL_POLICY_DEFAULT,
    fileOptions: { baseFile: [], editedFile: [], commit: ['HEAD'] },
    isGitRepo: false,
    recording: null,
    banners: {
      apiKey: { visible: false },
      agentConfig: { visible: false },
      dependency: { visible: false },
      gettingStarted: false,
      serviceOffline: null,
    },
    onboarding: 'done',
  };
}
