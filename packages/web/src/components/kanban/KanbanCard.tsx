import { useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { KanbanTask, KanbanTaskStatus } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CreateTaskModal } from '@/components/kanban/CreateTaskModal';

interface KanbanCardProps {
  task: KanbanTask;
  onUpdate: (id: string, updates: Partial<KanbanTask>) => void;
  onDelete: (id: string) => void;
}

const PRIORITY_VARIANT: Record<KanbanTask['priority'], 'destructive' | 'default' | 'secondary'> = {
  high: 'destructive',
  normal: 'default',
  low: 'secondary',
};

/** Status transitions reachable from a single button click on a card. */
function nextStatuses(status: KanbanTaskStatus): {
  promote?: { label: string; status: KanbanTaskStatus };
  demote?: { label: string; status: KanbanTaskStatus };
  requeue?: { status: KanbanTaskStatus };
} {
  switch (status) {
    case 'backlog':
      return { promote: { label: 'Promote to Ready', status: 'ready' } };
    case 'ready':
      return { demote: { label: 'Demote to Backlog', status: 'backlog' } };
    case 'failed':
      return { requeue: { status: 'ready' } };
    default:
      return {};
  }
}

export function KanbanCard({ task, onUpdate, onDelete }: KanbanCardProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const transitions = nextStatuses(task.status);

  return (
    <>
      <Card className="gap-2 px-3 py-3">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary line-clamp-2">{task.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Badge variant="outline" className="text-[10px]">
                {task.project}
              </Badge>
              <Badge variant={PRIORITY_VARIANT[task.priority]} className="text-[10px]">
                {task.priority}
              </Badge>
              {task.prd_id && (
                <Badge variant="outline" className="text-[10px]" title={`PRD ${task.prd_id}`}>
                  <ExternalLink className="size-3" />
                  PRD
                </Badge>
              )}
              {task.flags.serial && (
                <Badge variant="ghost" className="text-[10px]">
                  serial
                </Badge>
              )}
            </div>
          </div>
        </div>

        {task.description && (
          <p className="text-xs text-text-secondary line-clamp-3">{task.description}</p>
        )}

        {task.workflow_run_id && (task.status === 'running' || task.status === 'review') && (
          <a
            href={`/workflows/runs/${task.workflow_run_id}`}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="size-3" />
            View run
          </a>
        )}

        <div className="flex items-center justify-between gap-1 pt-1">
          <div className="flex items-center gap-1">
            {transitions.promote && (
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  const promote = transitions.promote;
                  if (promote) onUpdate(task.id, { status: promote.status });
                }}
                title={transitions.promote.label}
              >
                <ArrowRight className="size-3" />
                Ready
              </Button>
            )}
            {transitions.demote && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  const demote = transitions.demote;
                  if (demote) onUpdate(task.id, { status: demote.status });
                }}
                title={transitions.demote.label}
              >
                <ArrowLeft className="size-3" />
                Backlog
              </Button>
            )}
            {transitions.requeue && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const requeue = transitions.requeue;
                  if (requeue) onUpdate(task.id, { status: requeue.status });
                }}
                title="Re-queue to Ready"
              >
                <RefreshCw className="size-3" />
                Re-queue
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                setEditing(true);
              }}
              title="Edit task"
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                if (confirm(`Delete task "${task.title}"?`)) onDelete(task.id);
              }}
              title="Delete task"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </div>
      </Card>

      {editing && (
        <CreateTaskModal
          mode="edit"
          existingTask={task}
          projects={[task.project]}
          defaultProject={task.project}
          onClose={() => {
            setEditing(false);
          }}
          onSubmit={updates => {
            onUpdate(task.id, updates);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}
