/**
 * The `host` snapshot the shell reads (PRD one-fold-three-renderers, 8.1):
 * host-provided data no surface may disagree about. A selection may differ
 * between two surfaces on one session; a catalog may not, so catalogs live
 * here and never in `Surface`. Components take it as a property; the root
 * receives it with the events frame (`sessionFrames.ts`), and the design
 * harness passes literals. A schema because it crosses the bridge.
 */
import { Schema, Struct } from 'effect';
import {
  getBasename,
  ModelOptionDataSchema,
  TeamOptionDataSchema,
  ApprovalPolicySchema,
  APPROVAL_POLICY_DEFAULT,
} from '@texra-ai/harness/schemas';

import { DocumentAgentOptionSchema } from '@texra/shared/plugins/documents';

const visible = { visible: Schema.Boolean };

/** Open workspace folder offered as a run working directory. */
const WorkspaceRootOptionDataSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});

const AgentConfigBannerDataSchema = Schema.Struct({
  agentName: Schema.optional(Schema.NullOr(Schema.String)),
  customDirSet: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

/**
 * One missing dependency as the host reports it: already labeled for
 * display, and marked when another entry in the same list satisfies the same
 * requirement (GraphicsMagick vs ImageMagick) — the wire carries that
 * choose-one fact so no renderer has to decode it from an id.
 */
const MissingToolSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  interchangeable: Schema.Boolean,
  /** What TeXRA can't do without it, completing "TeXRA can't …". */
  usedFor: Schema.String,
});
export type MissingTool = typeof MissingToolSchema.Type;

const DependencyBannerDataSchema = Schema.Struct({
  missingTools: Schema.optional(Schema.NullOr(Schema.Array(MissingToolSchema))),
});

const FileOptionsSchema = Schema.Struct({
  baseFile: Schema.Array(Schema.String),
  editedFile: Schema.Array(Schema.String),
  commit: Schema.Array(Schema.String),
});
export type FileOptions = typeof FileOptionsSchema.Type;

/** How a project is named in a rail row, a chip, and the hero subtitle. */
const ProjectDisplaySchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  initials: Schema.String,
  subtitle: Schema.String,
});
export type ProjectDisplay = typeof ProjectDisplaySchema.Type;

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
const OnboardingFunnelStateSchema = Schema.Literals([
  'needs-credential',
  'setup',
  'done',
]);
export type OnboardingFunnelState = typeof OnboardingFunnelStateSchema.Type;

export const HostSnapshotSchema = Schema.Struct({
  project: ProjectDisplaySchema,
  /** Every agent; one that is also a document task carries its `rounds`. */
  agentOptions: Schema.Array(DocumentAgentOptionSchema),
  modelOptions: Schema.Array(ModelOptionDataSchema),
  teamOptions: Schema.Array(TeamOptionDataSchema),
  workspaceRoots: Schema.Array(WorkspaceRootOptionDataSchema),
  /** The project's configured policy, shown before a task is launched. */
  approvalPolicy: ApprovalPolicySchema,
  fileOptions: FileOptionsSchema,
  isGitRepo: Schema.Boolean,
  /** The one recorder per process and where its take is going. */
  recording: Schema.NullOr(
    Schema.Struct({ session: Schema.String, target: Schema.String }),
  ),
  /** The New-task state's notices; host-owned visibility. */
  banners: Schema.Struct({
    /** A credential that worked (a task has finished) stopped working;
     *  before a first task the "Connect a model" card is the prompt. */
    apiKey: Schema.Struct(visible),
    agentConfig: AgentConfigBannerDataSchema.mapFields(Struct.assign(visible)),
    dependency: DependencyBannerDataSchema.mapFields(Struct.assign(visible)),
    gettingStarted: Schema.Boolean,
    /** Why the background service this window's tasks run in is out of
     *  reach (it went away and the window is reaching it again, or a newer
     *  TeXRA's service refused this window); null while it is reached. */
    serviceOffline: Schema.NullOr(Schema.String),
  }),
  onboarding: OnboardingFunnelStateSchema,
});
export type HostSnapshot = typeof HostSnapshotSchema.Type;

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
