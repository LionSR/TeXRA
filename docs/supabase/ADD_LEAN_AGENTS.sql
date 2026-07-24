-- Migration: Move lean agents to tool-use-lean/ bucket, add leanBlueprint,
-- and rename lean → leanOrchestrator.
--
-- Prerequisites:
-- 1. Upload YAMLs to Supabase Storage under agent-configs/tool-use-lean/:
--    - leanSearch.yaml       (from prompts/agents/remote/Lean4/leanSearch.yaml)
--    - leanSimplifier.yaml   (from prompts/agents/remote/Lean4/leanSimplifier.yaml)
--    - leanBlueprint.yaml    (from prompts/agents/remote/Lean4/leanBlueprint.yaml)
--    - leanOrchestrator.yaml (from prompts/agents/remote/Lean4/leanOrchestrator.yaml)
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
-- STEP 2: Remove old lean agent (replaced by leanOrchestrator)
-- =============================================================================

DELETE FROM remote_agents WHERE name = 'lean';

-- =============================================================================
-- STEP 3: Add new agents
-- =============================================================================

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'leanOrchestrator',
  'Lean 4 project orchestrator — coordinates formalization, delegates to specialized Lean agents, and manages proof development workflow.',
  'tool-use-lean/leanOrchestrator.yaml',
  ARRAY['researcher', 'lean'],
  'toolUse',
  ARRAY['delegate_workflow', 'delegate_agent', 'executions', 'accept_run_files', 'todo_write', 'plan', 'read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'codex', 'lean_diagnostics', 'lean_inspect', 'lean_loogle', 'lean_file', 'lean_project']
)
ON CONFLICT (name) DO UPDATE SET
  description    = EXCLUDED.description,
  storage_path   = EXCLUDED.storage_path,
  visibility     = EXCLUDED.visibility,
  agent_category = EXCLUDED.agent_category,
  tools          = EXCLUDED.tools;

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'leanBlueprint',
  'Creates and maintains LeanBlueprint documents — dependency-tracked LaTeX that bridges informal math and Lean 4 formalization.',
  'tool-use-lean/leanBlueprint.yaml',
  ARRAY['researcher', 'lean'],
  'toolUse',
  ARRAY['todo_write', 'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'memory', 'lean_diagnostics', 'lean_file', 'lean_project', 'lean_inspect', 'lean_loogle', 'web_search', 'web_fetch', 'arxiv_search', 'arxiv_metadata', 'download_arxiv_source', 'crossref_search', 'zotero_add', 'zotero_search', 'zotero_export']
)
ON CONFLICT (name) DO UPDATE SET
  description    = EXCLUDED.description,
  storage_path   = EXCLUDED.storage_path,
  visibility     = EXCLUDED.visibility,
  agent_category = EXCLUDED.agent_category,
  tools          = EXCLUDED.tools;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT name, description, storage_path, agent_category, tools
FROM remote_agents
WHERE name IN ('leanOrchestrator', 'leanSearch', 'leanSimplifier', 'leanBlueprint')
ORDER BY name;
