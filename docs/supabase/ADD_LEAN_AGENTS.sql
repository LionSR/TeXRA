-- Migration: Move lean agents to tool-use-lean/ bucket and add leanBlueprint + lean.
--
-- Prerequisites:
-- 1. Upload YAMLs to Supabase Storage under agent-configs/tool-use-lean/:
--    - leanSearch.yaml   (from reference-agents/leanSearch.yaml)
--    - leanSimplifier.yaml (from reference-agents/leanSimplifier.yaml)
--    - leanBlueprint.yaml  (from reference-agents/leanBlueprint.yaml)
--    - lean.yaml           (moved from tool-use/lean.yaml)
--
-- Then run this SQL in Supabase SQL Editor.

-- =============================================================================
-- STEP 1: Update existing lean agents to new storage path
-- =============================================================================

UPDATE remote_agents
SET storage_path = 'tool-use-lean/leanSearch.yaml'
WHERE name = 'leanSearch';

UPDATE remote_agents
SET storage_path = 'tool-use-lean/leanSimplifier.yaml'
WHERE name = 'leanSimplifier';

-- =============================================================================
-- STEP 2: Add new agents
-- =============================================================================

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'lean',
  'Lean 4 proof assistant with VS Code integration and CLI fallback.',
  'tool-use-lean/lean.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['todo_write', 'lean_diagnostics', 'lean_file', 'lean_project', 'lean_inspect', 'lean_loogle', 'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'ls', 'memory']
)
ON CONFLICT (name) DO UPDATE SET
  description    = EXCLUDED.description,
  storage_path   = EXCLUDED.storage_path,
  agent_category = EXCLUDED.agent_category,
  tools          = EXCLUDED.tools;

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'leanBlueprint',
  'Creates and maintains LeanBlueprint documents — dependency-tracked LaTeX that bridges informal math and Lean 4 formalization.',
  'tool-use-lean/leanBlueprint.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['todo_write', 'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'ls', 'memory', 'lean_diagnostics', 'lean_file', 'lean_project', 'lean_inspect', 'lean_loogle', 'web_search', 'web_fetch', 'arxiv_search', 'arxiv_metadata', 'download_arxiv_source', 'crossref_search', 'crossref_doi', 'zotero_add', 'zotero_search', 'zotero_export']
)
ON CONFLICT (name) DO UPDATE SET
  description    = EXCLUDED.description,
  storage_path   = EXCLUDED.storage_path,
  agent_category = EXCLUDED.agent_category,
  tools          = EXCLUDED.tools;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT name, description, storage_path, agent_category, tools
FROM remote_agents
WHERE name IN ('lean', 'leanSearch', 'leanSimplifier', 'leanBlueprint')
ORDER BY name;
