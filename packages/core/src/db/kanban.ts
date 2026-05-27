/**
 * Database operations for kanban tasks (dev-system pipeline board).
 * Mirrors workflows.ts patterns: pool.query with $-positional params, normalizer
 * for JSON columns (SQLite stores TEXT), comprehensive error logging.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';

export type KanbanTaskStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done' | 'failed';
export type KanbanTaskPriority = 'low' | 'normal' | 'high';

export interface KanbanTaskFlags {
  serial?: boolean;
  depends?: string[];
  skip?: string[];
  [key: string]: unknown;
}

export interface KanbanTask {
  id: string;
  project: string;
  title: string;
  description: string | null;
  status: KanbanTaskStatus;
  priority: KanbanTaskPriority;
  prd_id: string | null;
  flags: KanbanTaskFlags;
  workflow_run_id: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.kanban');
  return cachedLog;
}

/**
 * Normalize a row from the database.
 * SQLite stores `flags` as TEXT (JSON string); PostgreSQL returns parsed JSONB.
 */
function normalizeKanbanTask<T extends KanbanTask>(row: T): T {
  if (typeof row.flags === 'string') {
    try {
      row.flags = JSON.parse(row.flags) as KanbanTaskFlags;
    } catch {
      row.flags = {};
    }
  }
  return row;
}

export interface ListKanbanTasksOptions {
  project?: string;
  status?: KanbanTaskStatus;
  limit?: number;
  offset?: number;
}

export async function listKanbanTasks(options?: ListKanbanTasksOptions): Promise<KanbanTask[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.project) {
    values.push(options.project);
    whereClauses.push(`project = $${String(values.length)}`);
  }
  if (options?.status) {
    values.push(options.status);
    whereClauses.push(`status = $${String(values.length)}`);
  }

  const limit = options?.limit ?? 200;
  const offset = options?.offset ?? 0;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;
  values.push(offset);
  const offsetParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<KanbanTask>(
      `SELECT * FROM remote_agent_kanban_tasks ${whereStr}
       ORDER BY created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values
    );
    return result.rows.map(normalizeKanbanTask);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.kanban_tasks_list_failed');
    throw new Error(`Failed to list kanban tasks: ${err.message}`);
  }
}

export async function getKanbanTask(id: string): Promise<KanbanTask | null> {
  try {
    const result = await pool.query<KanbanTask>(
      'SELECT * FROM remote_agent_kanban_tasks WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? normalizeKanbanTask(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, id }, 'db.kanban_task_get_failed');
    throw new Error(`Failed to get kanban task: ${err.message}`);
  }
}

export interface CreateKanbanTaskInput {
  project: string;
  title: string;
  description?: string;
  status?: KanbanTaskStatus;
  priority?: KanbanTaskPriority;
  prd_id?: string;
  flags?: KanbanTaskFlags;
}

export async function createKanbanTask(data: CreateKanbanTaskInput): Promise<KanbanTask> {
  try {
    const result = await pool.query<KanbanTask>(
      `INSERT INTO remote_agent_kanban_tasks
         (project, title, description, status, priority, prd_id, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.project,
        data.title,
        data.description ?? null,
        data.status ?? 'backlog',
        data.priority ?? 'normal',
        data.prd_id ?? null,
        JSON.stringify(data.flags ?? {}),
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error('INSERT returned no rows');
    return normalizeKanbanTask(row);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.kanban_task_create_failed');
    throw new Error(`Failed to create kanban task: ${err.message}`);
  }
}

export interface UpdateKanbanTaskInput {
  title?: string;
  description?: string | null;
  status?: KanbanTaskStatus;
  priority?: KanbanTaskPriority;
  prd_id?: string | null;
  flags?: KanbanTaskFlags;
  workflow_run_id?: string | null;
  branch?: string | null;
}

export async function updateKanbanTask(
  id: string,
  updates: UpdateKanbanTaskInput
): Promise<KanbanTask> {
  const dialect = getDialect();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  function add(column: string, value: unknown): void {
    values.push(value);
    setClauses.push(`${column} = $${String(values.length)}`);
  }

  if (updates.title !== undefined) add('title', updates.title);
  if (updates.description !== undefined) add('description', updates.description);
  if (updates.status !== undefined) add('status', updates.status);
  if (updates.priority !== undefined) add('priority', updates.priority);
  if (updates.prd_id !== undefined) add('prd_id', updates.prd_id);
  if (updates.flags !== undefined) add('flags', JSON.stringify(updates.flags));
  if (updates.workflow_run_id !== undefined) add('workflow_run_id', updates.workflow_run_id);
  if (updates.branch !== undefined) add('branch', updates.branch);

  if (setClauses.length === 0) {
    const existing = await getKanbanTask(id);
    if (!existing) throw new Error(`Kanban task not found (id: ${id})`);
    return existing;
  }

  setClauses.push(`updated_at = ${dialect.now()}`);
  values.push(id);
  const idParam = `$${String(values.length)}`;

  try {
    const result = await pool.query(
      `UPDATE remote_agent_kanban_tasks SET ${setClauses.join(', ')} WHERE id = ${idParam}`,
      values
    );
    if (result.rowCount === 0) {
      throw new Error(`Kanban task not found (id: ${id})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Kanban task not found')) throw error;
    const err = error as Error;
    getLog().error({ err, id }, 'db.kanban_task_update_failed');
    throw new Error(`Failed to update kanban task: ${err.message}`);
  }

  const updated = await getKanbanTask(id);
  if (!updated) throw new Error(`Kanban task vanished after update (id: ${id})`);
  return updated;
}

export async function deleteKanbanTask(id: string): Promise<boolean> {
  try {
    const result = await pool.query('DELETE FROM remote_agent_kanban_tasks WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, id }, 'db.kanban_task_delete_failed');
    throw new Error(`Failed to delete kanban task: ${err.message}`);
  }
}
