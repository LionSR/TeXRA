-- Migration: Add presenter, search, and simplifier as remote tool-use agents,
-- and sync descriptions/tools for existing remote agents.
--
-- Prerequisites:
-- 1. Upload the YAML files to Supabase Storage:
--    - Copy from: prompts/agents/remote/presenter.yaml
--    - Upload to: Storage > agent-configs > tool_use/presenter.yaml
--
--    - Copy from: prompts/agents/remote/search.yaml
--    - Upload to: Storage > agent-configs > tool_use/search.yaml
--
--    - Copy from: prompts/agents/remote/simplifier.yaml
--    - Upload to: Storage > agent-configs > tool_use/simplifier.yaml
--
-- Then run this SQL in Supabase SQL Editor:

-- =============================================================================
-- STEP 1: Ensure tools column exists (idempotent)
-- =============================================================================

ALTER TABLE remote_agents
ADD COLUMN IF NOT EXISTS tools TEXT[] DEFAULT NULL;

-- =============================================================================
-- STEP 2: Insert new agents
-- =============================================================================

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'presenter',
  'Interactive scientific presentation builder with visual QA.',
  'tool_use/presenter.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['todo_write', 'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'extract_figures', 'extract_bib_entries', 'extract_tikz_figures', 'wolfram', 'arxiv_search', 'arxiv_metadata', 'web_search', 'web_fetch']
);

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'search',
  'Research assistant with web search and literature discovery tools.',
  'tool_use/search.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['bash', 'read_file', 'glob', 'grep', 'extract_figures', 'extract_bib_entries', 'extract_tikz_figures', 'arxiv_search', 'arxiv_metadata', 'download_arxiv_source', 'crossref_search', 'zotero_add', 'zotero_search', 'zotero_export', 'web_search', 'web_fetch']
);

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'simplifier',
  'Simplifies scientific code and LaTeX for clarity and maintainability while preserving all functionality.',
  'tool_use/simplifier.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['todo_write', 'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'diagnostics', 'extract_figures', 'extract_tikz_figures', 'memory']
);

-- =============================================================================
-- STEP 3: Sync descriptions and agent_category for existing remote agents
-- =============================================================================

-- Fix transcribe_audio: sync trailing period from YAML, ensure agent_category
UPDATE remote_agents
SET description = 'Transcribes audio with speaker identification and LaTeX math formatting.',
    agent_category = 'workflow'
WHERE name = 'transcribe_audio';

-- apply and apply_multiple: ensure agent_category is set
UPDATE remote_agents
SET agent_category = 'workflow'
WHERE name IN ('apply', 'apply_multiple');

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT name, description, agent_category, tools, visibility
FROM remote_agents
ORDER BY name;
