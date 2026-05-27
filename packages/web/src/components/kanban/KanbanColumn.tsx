import type { KanbanTask, KanbanTaskStatus } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { KanbanCard } from '@/components/kanban/KanbanCard';

interface KanbanColumnProps {
  title: string;
  status: KanbanTaskStatus;
  tasks: KanbanTask[];
  onUpdate: (id: string, updates: Partial<KanbanTask>) => void;
  onDelete: (id: string) => void;
}

export function KanbanColumn({
  title,
  tasks,
  onUpdate,
  onDelete,
}: KanbanColumnProps): React.ReactElement {
  return (
    <div className="flex h-full min-h-0 w-72 flex-shrink-0 flex-col rounded-lg border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <Badge variant="outline" className="text-[10px]">
          {tasks.length}
        </Badge>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
        {tasks.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-text-secondary">No tasks</p>
        ) : (
          tasks.map(task => (
            <KanbanCard key={task.id} task={task} onUpdate={onUpdate} onDelete={onDelete} />
          ))
        )}
      </div>
    </div>
  );
}
