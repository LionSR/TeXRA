/**
 * The `host` snapshot the shell reads:
 * host-provided data no surface may disagree about. A selection may differ
 * between two surfaces on one session; a catalog may not, so catalogs live
 * here and never in `Surface`. Components take it as a property; the root
 * receives it with the events frame (`sessionFrames.ts`), and the design
 * harness passes literals. A schema because it crosses the bridge.
 */
import { Schema } from 'effect';
import {
  getBasename,
  ApprovalPolicySchema,
  APPROVAL_POLICY_DEFAULT,
  RunIdSchema,
  DeclinableUsageRouteSchema,
  NonNegativeIntSchema,
  PlanQuotaFailureSchema,
} from '@texra-ai/worldline/schemas';
import { SubscriptionUsageWindowSchema } from '@texra/shared/model/subscriptionUsage';
import { ModelOptionDataSchema } from '@texra/shared/pickerOptions';

/** Open workspace folder offered as a run working directory. */
const WorkspaceRootOptionDataSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});

/**
 * One missing dependency as the host reports it: already labeled for
 * display, and marked when another entry in the same list satisfies the same
 * requirement (GraphicsMagick vs ImageMagick) — the wire carries that
 * choose-one fact so no renderer has to decode it from an id.
 */
const MissingToolSchema = Schema.Struct({
  label: Schema.String,
  interchangeable: Schema.Boolean,
  /** What TeXRA can't do without it, completing "TeXRA can't …". */
  usedFor: Schema.String,
});
export type MissingTool = typeof MissingToolSchema.Type;

/** How a project is named in a rail row, a chip, and the hero title. */
const ProjectDisplaySchema = Schema.Struct({
  key: Schema.NonEmptyString,
  name: Schema.String,
});
export type ProjectDisplay = typeof ProjectDisplaySchema.Type;

/** A project's name in every host: its folder's name, or the whole path for
 *  a root that has none (`/`). */
export function projectName(root: string): string {
  return getBasename(root) || root;
}

/** The display record of one open folder, produced by the host once so no
 *  renderer derives a name from a path; the no-folder session reads as the
 *  prompt to open one. */
export function projectDisplayOf(
  key: string,
  root: string | undefined,
): ProjectDisplay {
  if (root === undefined) return { key, name: 'No project open' };
  return { key, name: projectName(root) };
}

/**
 * Where the onboarding funnel stands: the
 * state hosts push to webviews. `onboardingFunnel.ts` derives it.
 */
const OnboardingFunnelStateSchema = Schema.Literals([
  'needs-credential',
  'setup',
  'done',
]);
export type OnboardingFunnelState = typeof OnboardingFunnelStateSchema.Type;

/**
 * What the process knows of one subscription plan's quota: its windows as
 * last learned and when, or why none is known. `unobserved` is a plan whose
 * replies state its quota and none has arrived in this process yet.
 */
const PlanUsageSchema = Schema.Struct({
  plan: DeclinableUsageRouteSchema,
  /** The plan's tier as its provider names it, when it says: plans of one
   *  route differ in their windows and limits, so the name is the
   *  provider's and no window is assumed. */
  planName: Schema.optional(Schema.NonEmptyString),
  windows: Schema.Array(SubscriptionUsageWindowSchema),
  /** When the windows were learned, in epoch milliseconds. */
  at: Schema.optional(NonNegativeIntSchema),
  unknown: Schema.optional(
    Schema.Literals(['unobserved', ...PlanQuotaFailureSchema.literals]),
  ),
});
export type PlanUsage = typeof PlanUsageSchema.Type;

export const HostSnapshotSchema = Schema.Struct({
  project: ProjectDisplaySchema,
  /** The project's agent: the run the window opens on, listed first and
   *  marked in the run list. Null with none recorded and for a window with
   *  no folder. */
  agent: Schema.NullOr(RunIdSchema),
  modelOptions: Schema.Array(ModelOptionDataSchema),
  /** The quota of each subscription plan a listed model bills, for the
   *  status bar's meters; a plan nothing states the quota of is left out. */
  planUsage: Schema.Array(PlanUsageSchema),
  /** How a tool call is painted, from what the process's plugins declare
   *  (`TexraPlugin`): its icon by normalized tool name, and the tools whose
   *  output reads as a terminal session. */
  tools: Schema.Struct({
    icons: Schema.Record(Schema.String, Schema.String),
    terminalOutput: Schema.Array(Schema.String),
  }),
  workspaceRoots: Schema.Array(WorkspaceRootOptionDataSchema),
  /** The project's configured policy, shown before a task is launched. */
  approvalPolicy: ApprovalPolicySchema,
  /** The one recorder per process and where its take is going. */
  recording: Schema.NullOr(
    Schema.Struct({ session: Schema.String, target: Schema.String }),
  ),
  /** The New-task state's notices, each shown while it is set. */
  banners: Schema.Struct({
    /** A credential that worked (a task has finished) stopped working;
     *  before a first task the "Connect a model" card is the prompt. */
    apiKey: Schema.Boolean,
    /** The tools TeXRA needs that this machine lacks; never empty. */
    dependency: Schema.NullOr(Schema.Array(MissingToolSchema)),
    gettingStarted: Schema.Boolean,
    /** Where this window's tasks run, when the user should be told:
     *  `offline` while the background service they run in is out of reach
     *  (it went away and the window is reaching it again, or a newer
     *  TeXRA's service refused this window), and no task starts; `local`
     *  when the window's folder runs its tasks in this process, because the
     *  service was out of reach when it opened. Null while a service
     *  window's service is reached, and for a window with no folder. */
    service: Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal('offline'),
          reason: Schema.String,
        }),
        Schema.Struct({ kind: Schema.Literal('local'), reason: Schema.String }),
      ]),
    ),
  }),
  onboarding: OnboardingFunnelStateSchema,
});
export type HostSnapshot = typeof HostSnapshotSchema.Type;

export function emptyHostSnapshot(project: ProjectDisplay): HostSnapshot {
  return {
    project,
    agent: null,
    modelOptions: [],
    planUsage: [],
    tools: { icons: {}, terminalOutput: [] },
    workspaceRoots: [],
    approvalPolicy: APPROVAL_POLICY_DEFAULT,
    recording: null,
    banners: {
      apiKey: false,
      dependency: null,
      gettingStarted: false,
      service: null,
    },
    onboarding: 'done',
  };
}
