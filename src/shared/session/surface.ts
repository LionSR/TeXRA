/**
 * The Surface (PRD one-fold-three-renderers, section 9): every interaction
 * fact a renderer owns for one view instance and one open session. It is
 * the second of the two records a component reads (`SessionView` is the
 * first) and the only place selection, drafts, expansion, focus, and layout
 * live. Components never hold their own copy; they read the
 * record and dispatch a `SurfaceAction`, and the root applies it through
 * `applySurfaceAction`.
 *
 * The signal record holds `Map`s. Webview state crosses `JSON.stringify`,
 * where a `Map` serializes to `{}`, so the persisted form beside it is a Zod
 * schema whose maps are entry arrays, rebuilt into `Map`s at load.
 */
import { z } from 'zod';

import {
  InquiryDraftSchema,
  LaunchTargetSchema,
  SessionTypeSchema,
  ToolConfigFieldsSchema,
  UIFileFieldsSchema,
  RunIdSchema,
  isModelOptionAvailable,
  type InquiryDraft,
  type RunId,
} from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import {
  acceptsFollowUp,
  type FollowUpHost,
  type SessionView,
  type RunView,
} from './sessionView';
import { markShownRunSeen } from './unseenRuns';
import type { HostSnapshot } from './hostSnapshot';
import type { RequestErrorWire } from './sessionFrames';

/**
 * The new-task composer's selections, separate from host-derived state.
 * One agent and one instruction: the agent's category is the run type, so
 * `sessionType` is always written together with `agent` and never chosen
 * on its own.
 */
export const LaunchSurfaceSchema = UIFileFieldsSchema.merge(
  ToolConfigFieldsSchema,
).extend({
  sessionType: SessionTypeSchema.prefault('toolUse'),
  launchTarget: LaunchTargetSchema.prefault('agent'),
  selectedTeamId: z.string().prefault(''),
  workingDirectory: z.string().prefault(''),
  agent: z.string().prefault('orchestrator'),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  commit: z.string().prefault('HEAD'),
  instruction: z.string().prefault(''),
  baseFile: z.string().prefault(''),
});
type LaunchSurface = z.infer<typeof LaunchSurfaceSchema>;

type LaunchShape = typeof LaunchSurfaceSchema.shape;

/** A change to the launcher, carried by the host's `surface.action`: every
 *  field optional with its `.prefault` unwrapped, since `.partial()` keeps
 *  prefaults that Zod runs for an absent key, so `{ commit }` would reset
 *  the agent, the draft and the file lists. */
export const LaunchPatchSchema = z.object(
  Object.fromEntries(
    Object.entries(LaunchSurfaceSchema.shape).map(([key, field]) => [
      key,
      (field instanceof z.ZodPrefault ? field.unwrap() : field).optional(),
    ]),
  ) as {
    [K in keyof LaunchShape]: z.ZodOptional<
      LaunchShape[K] extends z.ZodPrefault<infer Inner> ? Inner : LaunchShape[K]
    >;
  },
);
type LaunchPatch = z.infer<typeof LaunchPatchSchema>;

/** An image of a follow-up: the `[fileName]` chip its text carries and
 *  the stored file the send names, once the host has saved it. */
interface DraftImage {
  readonly fileName: string;
  readonly path: string | null;
}

/** A follow-up in progress for one stream. Only `text` persists. */
export interface Draft {
  readonly text: string;
  readonly images: readonly DraftImage[];
}

export const EMPTY_DRAFT: Draft = Object.freeze({
  text: '',
  images: Object.freeze([]),
});

/**
 * The desktop workbench layout rides in the surface as the desktop's own
 * record: `packages/desktop` declares its shape and the shared record only
 * carries it through persistence. Null on hosts without a workbench.
 */
type WorkbenchLayout = Readonly<Record<string, unknown>>;

/**
 * A refusal a surface paints. Cancellation is the user's own doing, so it
 * stays quiet and never reaches a surface field.
 */
export type SurfaceRefusal = Exclude<RequestErrorWire, { _tag: 'Cancelled' }>;

export interface Surface {
  /** Which paper this surface is for; the layer key. Never persisted. */
  readonly session: string;
  /** The last failed request from this surface. Never persisted. */
  readonly requestError: SurfaceRefusal | null;
  /**
   * The shown run, decided once: `pruneSurface` applies the surface's
   * `SelectionRule`, so every reader takes the field as is. `null` is the
   * New-task state on a project surface; a chat's rule maps it to its root.
   */
  readonly selected: RunId | null;
  readonly drafts: ReadonlyMap<RunId, Draft>;
  /** Foreground polish operations, keyed by stream id or `launch`. Never persisted. */
  readonly polishing: ReadonlySet<string>;
  /** Streams awaiting follow-up admission. Never persisted. */
  readonly sending: ReadonlySet<RunId>;
  /** The error the runtime answered this surface's last request on a stream
   *  with, until the next request on that stream. Never persisted. */
  readonly rejected: ReadonlyMap<RunId, SurfaceRefusal>;
  readonly launch: LaunchSurface;
  /** Keyed by `${InquiryThreadId}#${turn}`, never by stream. */
  readonly inquiryDrafts: ReadonlyMap<string, InquiryDraft>;
  /** The user's expansion choice per stream in the tree, absent until they
   *  make one; `forceExpanded` outranks it. */
  readonly expanded: ReadonlyMap<RunId, boolean>;
  /** Task groups and workflow row groups inside a transcript, per stream. */
  readonly groups: ReadonlyMap<RunId, ReadonlyMap<string, boolean>>;
  /** Per top-level run, the `lastTimestamp` this surface last showed. */
  readonly seen: ReadonlyMap<RunId, number>;
  /** Never persisted. */
  readonly focusedRow: string | null;
  /** Run-board tab strip; resolved at read through `resolvePhase`. */
  readonly phase: ReadonlyMap<RunId, string>;
  readonly drawerOpen: boolean;
  readonly toolsSheetOpen: boolean;
  /** The output list's "where files are stored" hint, dismissed once. */
  readonly storageHintDismissed: boolean;
  /** The drawer's filter. Never persisted. */
  readonly search: string;
  readonly workbench: WorkbenchLayout | null;
}

function entries<K extends z.ZodType, V extends z.ZodType>(key: K, value: V) {
  return z.array(z.tuple([key, value])).prefault([]);
}

/**
 * The persisted form: interaction state only, per view and session. A
 * missing field takes its default before validation (`prefault`); a corrupt
 * field fails the parse loudly rather than becoming a silent default —
 * `PersistedState` warns with the failing key and resets that session's
 * whole record to these defaults.
 */
export const PersistedSurfaceSchema = z.object({
  selected: RunIdSchema.nullable().prefault(null),
  launch: LaunchSurfaceSchema.prefault({}),
  /** Text only; image bytes are not persisted. */
  drafts: entries(RunIdSchema, z.string()),
  inquiryDrafts: entries(z.string(), InquiryDraftSchema),
  expanded: entries(RunIdSchema, z.boolean()),
  groups: entries(RunIdSchema, entries(z.string(), z.boolean())),
  phase: entries(RunIdSchema, z.string()),
  seen: entries(RunIdSchema, z.number()),
  drawerOpen: z.boolean().prefault(false),
  storageHintDismissed: z.boolean().prefault(false),
  workbench: z.record(z.string(), z.unknown()).nullable().prefault(null),
});
type PersistedSurface = z.infer<typeof PersistedSurfaceSchema>;

export function emptySurface(session: string): Surface {
  return loadSurface(session, PersistedSurfaceSchema.parse({}));
}

/** The signal record from its persisted form: entry arrays back into Maps. */
export function loadSurface(
  session: string,
  persisted: PersistedSurface,
): Surface {
  return {
    session,
    requestError: null,
    selected: persisted.selected,
    drafts: new Map(
      persisted.drafts.map(([id, text]) => [id, { ...EMPTY_DRAFT, text }]),
    ),
    polishing: new Set(),
    sending: new Set(),
    rejected: new Map(),
    launch: persisted.launch,
    inquiryDrafts: new Map(persisted.inquiryDrafts),
    expanded: new Map(persisted.expanded),
    groups: new Map(
      persisted.groups.map(([id, groups]) => [id, new Map(groups)]),
    ),
    seen: new Map(persisted.seen),
    focusedRow: null,
    phase: new Map(persisted.phase),
    drawerOpen: persisted.drawerOpen,
    toolsSheetOpen: false,
    storageHintDismissed: persisted.storageHintDismissed,
    search: '',
    workbench: persisted.workbench,
  };
}

/** The persisted form of a surface: interaction state only, Maps as entries. */
export function persistSurface(surface: Surface): PersistedSurface {
  return {
    selected: surface.selected,
    launch: surface.launch,
    drafts: [...surface.drafts]
      .filter(([, draft]) => draft.text.length > 0)
      .map(([id, draft]) => [id, draft.text]),
    inquiryDrafts: [...surface.inquiryDrafts],
    expanded: [...surface.expanded],
    groups: [...surface.groups].map(([id, groups]) => [id, [...groups]]),
    phase: [...surface.phase],
    seen: [...surface.seen],
    drawerOpen: surface.drawerOpen,
    storageHintDismissed: surface.storageHintDismissed,
    workbench: surface.workbench,
  };
}

function retain<V>(
  map: ReadonlyMap<RunId, V>,
  view: SessionView,
): ReadonlyMap<RunId, V> {
  const retained = [...map].filter(([id]) => view.runs.has(id));
  return retained.length === map.size ? map : new Map(retained);
}

/** The `Surface` fields that are stream-keyed maps, the only ones
 *  `pruneSurface` retains over; the branded `RunId` keeps `inquiryDrafts`
 *  (keyed by thread and turn, which no stream leaving retires) off it. */
type RunKeyedMapField = {
  [K in keyof Surface]: Surface[K] extends ReadonlyMap<RunId, unknown>
    ? K
    : never;
}[keyof Surface];

/**
 * The list `pruneSurface` reads, a `Record` so `satisfies` checks both
 * directions: a new stream-keyed `Surface` map is a compile error here until
 * it is listed, rather than a silent leak of deleted streams' entries.
 */
const PER_STREAM_MAP_FIELDS = {
  drafts: true,
  expanded: true,
  groups: true,
  phase: true,
  rejected: true,
  seen: true,
} as const satisfies Record<RunKeyedMapField, true>;
const PER_STREAM_MAPS = Object.keys(
  PER_STREAM_MAP_FIELDS,
) as readonly RunKeyedMapField[];

/**
 * Where a selection lands against the view, applied by `pruneSurface`. The
 * default browses the whole project: a run that left the view moves to the
 * first top-level run, else `null`; an explicit `null` (New task) stays.
 */
export type SelectionRule = (selected: RunId | null) => RunId | null;

function projectSelection(view: SessionView): SelectionRule {
  return (selected) =>
    selected === null || view.runs.has(selected)
      ? selected
      : (view.order.at(0) ?? null);
}

/**
 * Every per-stream map drops its entry when that stream leaves the view
 * (PRD 9): an id is never reused, so the entry can never become valid
 * again, and without the prune the maps and the persisted form grow without
 * bound. The selection is decided here once, by `select` (a chat passes its
 * tree scope). Returns the same record when nothing moved.
 */
export function pruneSurface(
  surface: Surface,
  view: SessionView,
  select: SelectionRule = projectSelection(view),
): Surface {
  // `retain` only ever drops entries, never changes a value, so each pruned
  // map keeps its field's element type; the maps are read through the common
  // read-only supertype and the once-narrowed patch is cast back at the end.
  const patch: Partial<
    Record<(typeof PER_STREAM_MAPS)[number], ReadonlyMap<RunId, unknown>>
  > & { selected?: RunId | null } = {};
  for (const key of PER_STREAM_MAPS) {
    const current: ReadonlyMap<RunId, unknown> = surface[key];
    const next = retain(current, view);
    if (next !== current) patch[key] = next;
  }
  const selected = select(surface.selected);
  if (selected !== surface.selected) patch.selected = selected;
  if (Object.keys(patch).length === 0) return surface;
  return { ...surface, ...patch } as Surface;
}

/**
 * The launcher's selections against the host's catalogs: a model the
 * catalog no longer enables moves to the first enabled one (the current
 * one when none is), and a working directory that is no longer an open
 * root clears to the default. Returns the same record when both hold.
 */
export function reconcileLaunch(surface: Surface, host: HostSnapshot): Surface {
  const { launch } = surface;
  const patch: Partial<LaunchSurface> = {};
  const current = host.modelOptions.find(
    (option) => option.value === launch.model,
  );
  if (
    host.modelOptions.length > 0 &&
    !(current && isModelOptionAvailable(current))
  ) {
    const next =
      host.modelOptions.find((option) => isModelOptionAvailable(option)) ??
      current ??
      host.modelOptions[0];
    if (next.value !== launch.model) patch.model = next.value;
  }
  if (
    launch.workingDirectory !== '' &&
    !host.workspaceRoots.some((root) => root.value === launch.workingDirectory)
  ) {
    patch.workingDirectory = '';
  }
  if (Object.keys(patch).length === 0) return surface;
  return { ...surface, launch: { ...launch, ...patch } };
}

/**
 * Whether a follow-up can be sent to a stream: the one rule the composer's
 * Send button and the host's submit accelerator (Cmd+Alt+E) both read, so
 * the surface a user sees and the keystroke that bypasses it cannot
 * disagree. The stream must take a follow-up at all (`acceptsFollowUp`, the
 * same answer that decides whether its composer is on screen), an empty
 * draft sends nothing, and a pasted image the host has not stored yet is
 * not ready to name.
 */
export function canSendFollowUp(
  run: RunView,
  draft: Draft,
  host: FollowUpHost,
): boolean {
  if (!acceptsFollowUp(run, host)) return false;
  if (draft.images.some((image) => image.path === null)) return false;
  return draft.text.trim() !== '' || draft.images.length > 0;
}

/**
 * The phase a workflow view shows — the run board and the terminal popup
 * alike: the viewer's choice while the model still has it, else the current
 * phase (the last opened one, or the first declared), else `null` for a run
 * with no phases.
 */
export function resolvePhase(
  chosen: string | undefined,
  phases: readonly { readonly key: string; readonly opened: boolean }[],
): string | null {
  if (chosen !== undefined && phases.some((phase) => phase.key === chosen)) {
    return chosen;
  }
  const opened = phases.findLast((phase) => phase.opened);
  return opened?.key ?? phases.at(0)?.key ?? null;
}

/**
 * Every change a component may ask of the surface. The root applies it;
 * a component never mutates the record. `selectNew` and `select` are also
 * host-initiated arms of `surface.action` (PRD 8.5).
 */
export type SurfaceAction =
  | { readonly kind: 'select'; readonly runId: RunId | null }
  | { readonly kind: 'selectNew' }
  | { readonly kind: 'dismissRequestError' }
  | { readonly kind: 'toggleDrawer' }
  | { readonly kind: 'drawer'; readonly open: boolean }
  | { readonly kind: 'toolsSheet'; readonly open: boolean }
  | { readonly kind: 'search'; readonly value: string }
  | {
      readonly kind: 'draft';
      readonly runId: RunId;
      readonly patch: Partial<Draft>;
    }
  | { readonly kind: 'launch'; readonly patch: LaunchPatch }
  | {
      readonly kind: 'inquiryDraft';
      readonly key: string;
      readonly draft: InquiryDraft | null;
    }
  | {
      readonly kind: 'expand';
      readonly runId: RunId;
      readonly expanded: boolean;
    }
  | {
      readonly kind: 'group';
      readonly runId: RunId;
      readonly key: string;
      readonly expanded: boolean;
    }
  | { readonly kind: 'focusRow'; readonly rowId: string | null }
  | {
      readonly kind: 'phase';
      readonly runId: RunId;
      readonly phase: string;
    }
  | { readonly kind: 'workbench'; readonly layout: WorkbenchLayout | null }
  | { readonly kind: 'dismissStorageHint' }
  | { readonly kind: 'seen'; readonly view: SessionView };

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V | null) {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

export function applySurfaceAction(
  surface: Surface,
  action: SurfaceAction,
): Surface {
  switch (action.kind) {
    case 'dismissRequestError':
      return { ...surface, requestError: null };
    case 'select':
      return { ...surface, selected: action.runId, drawerOpen: false };
    case 'selectNew':
      return { ...surface, selected: null, drawerOpen: false };
    case 'toggleDrawer':
      return { ...surface, drawerOpen: !surface.drawerOpen };
    case 'drawer':
      return { ...surface, drawerOpen: action.open };
    case 'toolsSheet':
      return { ...surface, toolsSheetOpen: action.open };
    case 'dismissStorageHint':
      return { ...surface, storageHintDismissed: true };
    case 'search':
      return { ...surface, search: action.value };
    case 'draft':
      return {
        ...surface,
        drafts: withEntry(surface.drafts, action.runId, {
          ...(surface.drafts.get(action.runId) ?? EMPTY_DRAFT),
          ...action.patch,
        }),
      };
    case 'launch': {
      const launch = { ...surface.launch, ...action.patch };
      // Naming an agent targets it, and only a tool-use launch runs a team.
      const toAgent =
        action.patch.agent !== undefined || launch.sessionType !== 'toolUse';
      return {
        ...surface,
        launch: toAgent ? { ...launch, launchTarget: 'agent' } : launch,
      };
    }
    case 'inquiryDraft':
      return {
        ...surface,
        inquiryDrafts: withEntry(
          surface.inquiryDrafts,
          action.key,
          action.draft,
        ),
      };
    case 'expand':
      return {
        ...surface,
        expanded: withEntry(surface.expanded, action.runId, action.expanded),
      };
    case 'group':
      return {
        ...surface,
        groups: withEntry(
          surface.groups,
          action.runId,
          withEntry(
            surface.groups.get(action.runId) ?? new Map<string, boolean>(),
            action.key,
            action.expanded,
          ),
        ),
      };
    case 'focusRow':
      return { ...surface, focusedRow: action.rowId };
    case 'phase':
      return {
        ...surface,
        phase: withEntry(surface.phase, action.runId, action.phase),
      };
    case 'workbench':
      return { ...surface, workbench: action.layout };
    case 'seen':
      return markShownRunSeen(surface, action.view);
  }
}
