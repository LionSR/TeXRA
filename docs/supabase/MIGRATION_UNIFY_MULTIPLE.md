# Supabase migration: retire `_multiple` remote agents

## What this migration does

Removes the 9 `*_multiple` rows from the `remote_agents` table now that the base agents (`apply`, `criticize`, `devise`, `elevate`, `enhance`, `generic`, `logic`, `notation`, `verifyFix`) handle both single-output and multi-output workflows through a single unified YAML each.

The 10 surviving workflow rows (`apply`, `criticize`, `devise`, `elevate`, `enhance`, `generic`, `humanize`, `logic`, `notation`, `verifyFix`) also get refreshed descriptions and storage paths from the new YAMLs.

## Why production care is needed

There is no staging Supabase environment in this repo — `src/auth/config.ts` points at the production project. A wrong migration touches real users immediately.

Two failure modes to plan around:

1. **Old clients in the field after the SQL DELETEs run** request `apply_multiple` (and friends) and get HTTP 404. The client-side dispatch shim that used to fall back to `apply` has been removed in this branch. So we must apply the migration in a way that doesn't leave a window where the published client still asks for `_multiple` names.
2. **The remote storage object** for each `_multiple.yaml` still exists in Supabase Storage after the DELETE. Leave those storage objects in place for ~one release cycle so a rolled-back client can still find them via the old metadata row if we have to restore from snapshot.

## Pre-migration checklist

Run all of these from a workstation logged into the production Supabase project. Do them in order.

1. **Snapshot the current state** via MCP — these become rollback artifacts:

   ```
   mcp__supabase__execute_sql with:
     SELECT name, description, storage_path, visibility, agent_category, tools
     FROM remote_agents
     ORDER BY name;
   ```

   Save the result. This is your row-level recovery point.

2. **Verify the generated SQL** matches the source of truth:

   ```bash
   npm run sync:remote-agents
   ```

   Prints the catalog SQL to stdout. Review the upserts and any `DELETE`s before applying.

3. **Build and validate the new extension locally**. Run an end-to-end test of `apply` on a 2-file input pointing at the production Supabase project (the new YAMLs are already deployed locally via `prompts/agents/remote/`). Confirm the prompt rendering is correct, all 9 unified agents work.

4. **Verify the currently-shipped client tolerates `documentTag: documents`**. The DELETE in step 2 is irreversible without a snapshot restore, and the shipped client's behavior under the new YAML is the only thing that can break it. Confirm `documentTag` is parsed at runtime, not pinned to `latex_documents`:

   ```bash
   # Replace <VERSION> with the published marketplace version users are on.
   curl -L -o /tmp/texra.vsix \
     "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/LionSR/vsextensions/texra/<VERSION>/vspackage"
   unzip -p /tmp/texra.vsix extension/dist/extension.js | grep -E "latex_documents|documentTag" | head -20
   ```

   Expect: `documentTag` referenced as a YAML field read, **not** any `latex_documents` literal hard-coded into the parser. If the published bundle pins `latex_documents`, **stop** — the migration would brick every shipped client between step 2 and the user upgrading. Coordinate a different rollout (e.g., publish first, wait for marketplace propagation, then DELETE).

## Migration steps (single coordinated release)

Execute in this order — do not parallelize.

### Step 1 — Upload the new YAML bodies to Storage

The 10 surviving workflow agents need their YAML content refreshed in Supabase Storage to match the unified prompts.

The sync script does **not** upload Storage objects — only metadata rows. Upload manually:

```bash
# From the repo root (with supabase CLI authenticated):
for agent in apply criticize devise elevate enhance generic humanize logic notation verifyFix; do
  folder=$(jq -r ".agents[\"$agent\"].folder" docs/supabase/remote-agents.config.json)
  supabase storage cp "prompts/agents/remote/${agent}.yaml" "ss:///agent-configs/${folder}/${agent}.yaml" --project-ref <PROJECT-REF>
done
```

Replace `<PROJECT-REF>` with the project ref and adjust the storage CLI invocation to match your tooling. The path layout is `<folder>/<agent>.yaml` where `<folder>` is the `folder` field from `remote-agents.config.json`.

This is safe to do **before** the SQL runs because:

- Old metadata rows still point at the same paths, so they overwrite in place.
- Old clients reading these files will get the unified YAML, which is a strict superset of the old behavior (the new prompt handles both N=1 and N>1).

**Do NOT delete** the `*_multiple.yaml` Storage objects in this step. Leave them for at least one release cycle.

### Step 2 — Apply the SQL

```bash
npm run sync:remote-agents -- --apply
```

Needs a `supabase link`ed checkout, or `SUPABASE_DB_URL`, or `SUPABASE_ACCESS_TOKEN` plus `SUPABASE_PROJECT_REF`. Alternatively, paste the generated SQL (`npm run sync:remote-agents`) into the Supabase Studio SQL editor.

Verify after:

```sql
SELECT COUNT(*) FROM remote_agents;
-- expect: previous_count - 9

SELECT name FROM remote_agents WHERE name LIKE '%_multiple';
-- expect: 0 rows
```

### Step 3 — Smoke test with the currently-shipped client

Before publishing the new extension, run the _currently shipped_ version of TeXRA against production Supabase. Trigger an `apply` agent run on a 2-file input. Expected behavior:

- Old client requests `apply_multiple` → Supabase returns 404 (row deleted).
- Old client falls back to `apply` (dispatch shim is still in the shipped version).
- Supabase returns the unified `apply.yaml` content.
- `documentTag` declared in the YAML is `documents` (not `latex_documents` as the old client expected for multi-output).

The third point was already verified in the pre-flight checklist (step 4) before the SQL ran — this smoke test is the runtime confirmation. If the old client breaks anyway, **roll back the SQL** using the snapshot from the pre-migration checklist:

```sql
-- For each retired row, re-insert from the snapshot
INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES ('apply_multiple', ..., ..., ..., 'workflow', NULL)
ON CONFLICT (name) DO UPDATE SET ...;
-- repeat for the other 8
```

### Step 4 — Publish the new extension

Once the smoke test passes:

```bash
npm run build:fast
vsce publish
ovsx publish
```

The new client never asks for `_multiple` names, so the deleted rows are irrelevant to it.

### Step 5 — Wait one release cycle, then clean up Storage

After ~1-2 weeks of normal usage with the new client, the `*_multiple.yaml` Storage objects are safe to delete (they have no metadata row pointing at them, so no client could ever fetch them). Use the Storage UI or:

```bash
for agent in apply criticize devise elevate enhance generic logic notation verifyFix; do
  retired_name="${agent}_multiple"
  if ! jq -e --arg name "$retired_name" '.retired | index($name)' docs/supabase/remote-agents.config.json >/dev/null; then
    echo "Skipping ${retired_name}: not listed as retired" >&2
    continue
  fi

  folder=$(jq -er --arg agent "$agent" '.agents[$agent].folder' docs/supabase/remote-agents.config.json)
  supabase storage rm "ss:///agent-configs/${folder}/${agent}_multiple.yaml" --project-ref <PROJECT-REF>
done
```

This step is housekeeping — orphaned Storage objects waste a few KB but don't affect users.

## Rollback summary

| Phase                              | Rollback action                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| After step 1 (Storage upload only) | No action — old SQL rows still point at the same paths; new YAMLs are a strict superset.                                                                                 |
| After step 2 (SQL applied)         | Re-insert the 9 retired rows from the snapshot. Old clients regain access immediately.                                                                                   |
| After step 4 (extension published) | Same SQL rollback. Old extension version remains downloadable from the marketplace; users who upgraded see no `_multiple` agents but the unified base agents still work. |
| After step 5 (Storage cleanup)     | Restore the deleted `*_multiple.yaml` Storage objects from a Supabase Storage backup — only needed if step 2 rollback is also needed.                                    |
