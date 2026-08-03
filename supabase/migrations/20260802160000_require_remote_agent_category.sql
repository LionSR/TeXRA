-- Make the remote-agent category a database invariant rather than a client
-- compatibility default. Existing null rows retain the former client-side
-- interpretation before the column becomes non-null.
UPDATE public.remote_agents
SET agent_category = 'workflow'
WHERE agent_category IS NULL;

ALTER TABLE public.remote_agents
  ALTER COLUMN agent_category SET DEFAULT 'workflow',
  ALTER COLUMN agent_category SET NOT NULL;
