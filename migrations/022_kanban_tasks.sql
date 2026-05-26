-- Kanban tasks table — replaces dev-system TODO.md as the dispatcher source of truth.
-- Tasks created via dev-idea slice node or directly in the Web UI; the dispatcher
-- polls status='ready' rows and starts archon workflow runs per task.

CREATE TABLE IF NOT EXISTS remote_agent_kanban_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project         VARCHAR(255) NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'backlog',
  priority        VARCHAR(10) NOT NULL DEFAULT 'normal',
  prd_id          VARCHAR(255),
  flags           JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  branch          VARCHAR(255),
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status          ON remote_agent_kanban_tasks(status);
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project         ON remote_agent_kanban_tasks(project);
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_workflow_run_id ON remote_agent_kanban_tasks(workflow_run_id);

COMMENT ON TABLE remote_agent_kanban_tasks IS
  'Kanban task board for the dev-system pipeline. Replaces TODO.md as the dispatcher source.';
