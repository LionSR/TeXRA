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
import type { HostSnapshot } from './hostSnapshot';
import type { RequestErrorWire } from './sessionFrames';
import type { SessionView, RunView } from './sessionView';

/** The new-task composer's selections, separate from host-derived state. */
export const LaunchSurfaceSchema = UIFileFieldsSchema.merge(
  ToolConfigFieldsSchema,
).extend({
  sessionType: SessionTypeSchema.prefault('toolUse'),
  launchTarget: LaunchTargetSchema.prefault('agent'),
  selectedTeamId: z.string().prefault(''),
  workingDirectory: z.string().prefault(''),
  agent: z
    .object({
      workflow: z.string().prefault('correct'),
      toolUse: z.string().prefault('orchestrator'),
    })
    .prefault({}),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  commit: z.string().prefault('HEAD'),
  instruction: z
    .object({
      workflow: z.string().prefault(''),
      toolUse: z.string().prefault(''),
    })
    .prefault({}),
  baseFile: z.string().prefault(''),
});
type LaunchSurface = z.infer<typeof LaunchSurfaceSchema>;

/** A change to the launcher: the per-category records merge one level
 *  deep, so a host can name the tool-use agent without knowing the
 *  workflow one. Zod because the host's `surface.action` carries it. */
const PerCategoryPatchSchema = z
  .object({ workflow: z.string().optional(), toolUse: z.string().optional() })
  .optional();
export const LaunchPatchSchema = LaunchSurfaceSchema.partial().extend({
  agent: PerCategoryPatchSchema,
  instruction: PerCategoryPatchSchema,
});
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
   * A preference, not a pointer: read it through `resolveSelected`. `null`
   * is the New-task state and resolves to itself.
   */
  readonly selected: RunId | null;
  readonly drafts: ReadonlyMap<RunId, Draft>;
  /** Foreground polish operations, keyed by stream id or `launch:<mode>`. Never persisted. */
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
  /** Never persisted. */
  readonly focusedRow: string | null;
  /** Run-board tab strip; resolved at read like `selected`. */
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
  drawerOpen: z.boolean().prefault(false),
  storageHintDismissed: z.boolean().prefault(false),
  workbench: z.record(z.string(), z.unknown()).nullable().prefault(null),
});
export type PersistedSurface = z.infer<typeof PersistedSurfaceSchema>;

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
    drawerOpen: surface.drawerOpen,
    storageHintDismissed: surface.storageHintDismissed,
    workbench: surface.workbench,
  };
}

function retain<V>(
  map: ReadonlyMap<RunId, V>,
  view: SessionView,
): ReadonlyMap<RunId, V> {
  if ([...map.keys()].every((id) => view.runs.has(id))) return map;
  return new Map([...map].filter(([id]) => view.runs.has(id)));
}

/**
 * The `Surface` fields that are stream-keyed maps — the only fields
 * `pruneSurface` may retain over. Restricting the list below to these keys
 * means a non-map field (`search`, `drawerOpen`) is refused at the list
 * itself, not several lines later at the read.
 */
type RunKeyedMapField = {
  [K in keyof Surface]: Surface[K] extends ReadonlyMap<RunId, unknown>
    ? K
    : never;
}[keyof Surface];

/**
 * The single list `pruneSurface` reads: the per-stream maps it retains over.
 * `RunKeyedMapField` refuses any entry that is not a stream-keyed map, so a
 * typo or a non-map field fails here at the list. It does not enforce the
 * reverse — the type system cannot, since `RunId` is `string` and so a
 * stream-keyed map is indistinguishable from any other string-keyed one — so a
 * new per-stream field added to `Surface` but left off this list still keeps a
 * deleted stream's entry forever, and adding such a field means adding it here.
 * `inquiryDrafts` is that indistinguishable case made deliberate: it is a
 * string-keyed map too, but keyed by `${InquiryThreadId}#${turn}`, not by
 * stream, so no stream leaving the view can retire one and it stays off.
 */
const PER_STREAM_MAPS = [
  'drafts',
  'expanded',
  'groups',
  'phase',
  'rejected',
] as const satisfies readonly RunKeyedMapField[];

/**
 * Every per-stream map drops its entry when that stream leaves the view
 * (PRD 9): an id is never reused, so the entry can never become valid
 * again, and without the prune the maps and the persisted form grow without
 * bound and keep a deleted conversation's draft. Returns the same record
 * when nothing left.
 */
export function pruneSurface(surface: Surface, view: SessionView): Surface {
  // `retain` only ever drops entries, never changes a value, so each pruned
  // map keeps its field's element type; the maps are read through the common
  // read-only supertype and the once-narrowed patch is cast back at the end.
  const patch: Partial<
    Record<(typeof PER_STREAM_MAPS)[number], ReadonlyMap<RunId, unknown>>
  > = {};
  for (const key of PER_STREAM_MAPS) {
    const current: ReadonlyMap<RunId, unknown> = surface[key];
    const next = retain(current, view);
    if (next !== current) patch[key] = next;
  }
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
 * What a surface shows: `selected` if the view still has that stream, else
 * the first top-level stream, else `null`. The fallback applies only to a
 * non-null id that has disappeared; an explicit `null` is the New-task
 * state and resolves to itself.
 */
export function resolveSelected(
  view: SessionView,
  surface: Surface,
): RunId | null {
  const { selected } = surface;
  if (selected === null) return null;
  if (view.runs.has(selected)) return selected;
  return view.order.at(0) ?? null;
}

/**
 * Whether a stream takes a follow-up at all: what decides the composer is
 * shown for it, and therefore what a host action aimed at it may assume. A
 * run that declares no follow-up support and one this process may not act
 * on take none; otherwise a run still going or waiting takes one, as does a
 * conversation that has not started (`ready` with nothing written yet).
 */
export function acceptsFollowUp(run: RunView): boolean {
  if (run.followUpSupport === 'unsupported' || run.readOnly) return false;
  if (run.group === 'running' || run.group === 'waiting') return true;
  return run.status === 'ready' && run.lastTimestamp === null;
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
export function canSendFollowUp(run: RunView, draft: Draft): boolean {
  if (!acceptsFollowUp(run)) return false;
  if (draft.images.some((image) => image.path === null)) return false;
  return draft.text.trim() !== '' || draft.images.length > 0;
}

/**
 * The phase the run board shows for a stream: the surface's choice while
 * the model still has it, else the current phase (the last opened one, or
 * the first declared), else `null` for a run with no phases.
 */
export function resolvePhase(
  surface: Surface,
  runId: RunId,
  phases: readonly { readonly key: string; readonly opened: boolean }[],
): string | null {
  const chosen = surface.phase.get(runId);
  if (chosen !== undefined && phases.some((phase) => phase.key === chosen)) {
    return chosen;
  }
  const opened = phases.findLast((phase) => phase.opened);
  return opened?.key ?? phases.at(0)?.key ?? null;
}

/**
 * Every change a component may ask of the surface. The root applies it;
 * a component never mutates the record. `selectNew` and `toggleDrawer` are
 * also the host-initiated arms of `surface.action` (PRD 8.5).
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
  | { readonly kind: 'dismissStorageHint' };

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
      const { agent, instruction, ...rest } = action.patch;
      const launch = {
        ...surface.launch,
        ...rest,
        agent: { ...surface.launch.agent, ...agent },
        instruction: { ...surface.launch.instruction, ...instruction },
      };
      // A team is a tool-use launch target: leaving that mode launches the
      // mode's agent, whatever target the tool-use mode had chosen.
      return {
        ...surface,
        launch:
          launch.sessionType === 'toolUse'
            ? launch
            : { ...launch, launchTarget: 'agent' },
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
  }
}
