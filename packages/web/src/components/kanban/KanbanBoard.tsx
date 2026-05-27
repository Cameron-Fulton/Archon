import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  listKanbanTasks,
  createKanbanTask,
  updateKanbanTask,
  deleteKanbanTask,
  listCodebases,
  type KanbanTask,
  type KanbanTaskStatus,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { KanbanColumn } from '@/components/kanban/KanbanColumn';
import { CreateTaskModal } from '@/components/kanban/CreateTaskModal';

const COLUMNS: { title: string; status: KanbanTaskStatus }[] = [
  { title: 'Backlog', status: 'backlog' },
  { title: 'Ready', status: 'ready' },
  { title: 'Running', status: 'running' },
  { title: 'Review', status: 'review' },
  { title: 'Done', status: 'done' },
  { title: 'Failed', status: 'failed' },
];

const ALL_PROJECTS = '__all__';

export function KanbanBoard(): React.ReactElement {
  const queryClient = useQueryClient();
  const [project, setProject] = useState<string>(ALL_PROJECTS);
  const [creating, setCreating] = useState(false);

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
  });

  const projectFilter = project === ALL_PROJECTS ? undefined : project;

  const {
    data: tasks,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['kanban-tasks', projectFilter ?? null],
    queryFn: () => listKanbanTasks({ project: projectFilter }),
    refetchInterval: 5_000,
  });

  const invalidate = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['kanban-tasks'] });

  const createMutation = useMutation({
    mutationFn: createKanbanTask,
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; updates: Partial<KanbanTask> }) =>
      updateKanbanTask(input.id, input.updates),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteKanbanTask,
    onSuccess: invalidate,
  });

  const projectNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    codebases?.forEach(cb => names.add(cb.name));
    tasks?.forEach(t => names.add(t.project));
    return Array.from(names).sort();
  }, [codebases, tasks]);

  const tasksByStatus = useMemo<Record<KanbanTaskStatus, KanbanTask[]>>(() => {
    const grouped: Record<KanbanTaskStatus, KanbanTask[]> = {
      backlog: [],
      ready: [],
      running: [],
      review: [],
      done: [],
      failed: [],
    };
    tasks?.forEach(task => {
      grouped[task.status].push(task);
    });
    return grouped;
  }, [tasks]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-text-primary">Kanban</h1>
          <select
            value={project}
            onChange={e => {
              setProject(e.target.value);
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value={ALL_PROJECTS}>All projects</option>
            {projectNames.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreating(true);
          }}
          disabled={projectNames.length === 0}
        >
          <Plus className="size-4" />
          New task
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-4 pb-4">
        {isLoading ? (
          <p className="px-2 py-8 text-sm text-text-secondary">Loading tasks...</p>
        ) : isError ? (
          <p className="px-2 py-8 text-sm text-destructive">Failed to load tasks.</p>
        ) : (
          <div className="flex h-full min-h-0 gap-3">
            {COLUMNS.map(col => (
              <KanbanColumn
                key={col.status}
                title={col.title}
                status={col.status}
                tasks={tasksByStatus[col.status]}
                onUpdate={(id, updates) => {
                  updateMutation.mutate({ id, updates });
                }}
                onDelete={id => {
                  deleteMutation.mutate(id);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateTaskModal
          mode="create"
          projects={projectNames}
          defaultProject={projectFilter}
          onClose={() => {
            setCreating(false);
          }}
          onSubmit={input => {
            createMutation.mutate(input);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
