/**
 * Zod schemas for kanban task API endpoints.
 * Backs the dev-system pipeline task board at /kanban.
 */
import { z } from '@hono/zod-openapi';

export const kanbanTaskStatusSchema = z
  .enum(['backlog', 'ready', 'running', 'review', 'done', 'failed'])
  .openapi('KanbanTaskStatus');

export const kanbanTaskPrioritySchema = z
  .enum(['low', 'normal', 'high'])
  .openapi('KanbanTaskPriority');

/** Dispatcher hint flags. `passthrough` lets us add new flags without bumping clients. */
export const kanbanTaskFlagsSchema = z
  .object({
    serial: z.boolean().optional(),
    depends: z.array(z.string()).optional(),
    skip: z.array(z.string()).optional(),
  })
  .passthrough()
  .openapi('KanbanTaskFlags');

export const kanbanTaskSchema = z
  .object({
    id: z.string(),
    project: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: kanbanTaskStatusSchema,
    priority: kanbanTaskPrioritySchema,
    prd_id: z.string().nullable(),
    flags: kanbanTaskFlagsSchema,
    workflow_run_id: z.string().nullable(),
    branch: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('KanbanTask');

export const kanbanTaskListResponseSchema = z
  .object({ tasks: z.array(kanbanTaskSchema) })
  .openapi('KanbanTaskListResponse');

export const listKanbanTasksQuerySchema = z.object({
  project: z.string().optional(),
  status: kanbanTaskStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const createKanbanTaskBodySchema = z
  .object({
    project: z.string().min(1).max(255),
    title: z.string().min(1),
    description: z.string().optional(),
    status: kanbanTaskStatusSchema.optional(),
    priority: kanbanTaskPrioritySchema.optional(),
    prd_id: z.string().optional(),
    flags: kanbanTaskFlagsSchema.optional(),
  })
  .openapi('CreateKanbanTaskBody');

export const updateKanbanTaskBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: kanbanTaskStatusSchema.optional(),
    priority: kanbanTaskPrioritySchema.optional(),
    prd_id: z.string().nullable().optional(),
    flags: kanbanTaskFlagsSchema.optional(),
    workflow_run_id: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
  })
  .openapi('UpdateKanbanTaskBody');

export const kanbanTaskIdParamsSchema = z.object({ id: z.string() });

export const deleteKanbanTaskResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteKanbanTaskResponse');
