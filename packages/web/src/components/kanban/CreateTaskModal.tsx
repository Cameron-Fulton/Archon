import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { KanbanTask, KanbanTaskPriority, KanbanTaskStatus, KanbanTaskFlags } from '@/lib/api';

interface BaseProps {
  projects: string[];
  defaultProject?: string;
  onClose: () => void;
}

interface CreateProps extends BaseProps {
  mode: 'create';
  existingTask?: undefined;
  onSubmit: (input: {
    project: string;
    title: string;
    description?: string;
    priority: KanbanTaskPriority;
    flags: KanbanTaskFlags;
  }) => void;
}

interface EditProps extends BaseProps {
  mode: 'edit';
  existingTask: KanbanTask;
  onSubmit: (updates: Partial<KanbanTask>) => void;
}

type CreateTaskModalProps = CreateProps | EditProps;

const PRIORITIES: KanbanTaskPriority[] = ['low', 'normal', 'high'];
const STATUSES: KanbanTaskStatus[] = ['backlog', 'ready', 'running', 'review', 'done', 'failed'];

export function CreateTaskModal(props: CreateTaskModalProps): React.ReactElement {
  const initial = props.existingTask;
  const [project, setProject] = useState(
    initial?.project ?? props.defaultProject ?? props.projects[0] ?? ''
  );
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [priority, setPriority] = useState<KanbanTaskPriority>(initial?.priority ?? 'normal');
  const [status, setStatus] = useState<KanbanTaskStatus>(initial?.status ?? 'backlog');
  const [serial, setSerial] = useState(Boolean(initial?.flags.serial));
  const [skipText, setSkipText] = useState((initial?.flags.skip ?? []).join(', '));

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!title.trim() || !project.trim()) return;

    const flags: KanbanTaskFlags = {};
    if (serial) flags.serial = true;
    const skipList = skipText
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (skipList.length > 0) flags.skip = skipList;

    if (props.mode === 'create') {
      props.onSubmit({
        project: project.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        flags,
      });
    } else {
      props.onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        priority,
        status,
        flags,
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.mode === 'create' ? 'Create kanban task' : 'Edit task'}</DialogTitle>
          <DialogDescription>
            {props.mode === 'create'
              ? 'New tasks land in Backlog. Promote to Ready to dispatch.'
              : 'Update task fields.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Project</label>
            {props.mode === 'create' && props.projects.length > 0 ? (
              <select
                value={project}
                onChange={e => {
                  setProject(e.target.value);
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                required
              >
                {props.projects.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={project}
                onChange={e => {
                  setProject(e.target.value);
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                disabled={props.mode === 'edit'}
                placeholder="e.g. supastarter-nextjs"
                required
              />
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => {
                setTitle(e.target.value);
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              placeholder="What needs to be done?"
              required
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">Description</label>
            <textarea
              value={description}
              onChange={e => {
                setDescription(e.target.value);
              }}
              className="min-h-[80px] w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              placeholder="Optional details, acceptance criteria, links..."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-text-secondary">Priority</label>
              <select
                value={priority}
                onChange={e => {
                  setPriority(e.target.value as KanbanTaskPriority);
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {PRIORITIES.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            {props.mode === 'edit' && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-text-secondary">Status</label>
                <select
                  value={status}
                  onChange={e => {
                    setStatus(e.target.value as KanbanTaskStatus);
                  }}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  {STATUSES.map(s => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-md border border-border bg-background/50 p-3">
            <p className="text-xs font-medium text-text-secondary">Dispatcher flags</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={serial}
                onChange={e => {
                  setSerial(e.target.checked);
                }}
              />
              <span>Serial (wait for other tasks in same project)</span>
            </label>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Skip stages (comma-separated)</label>
              <input
                type="text"
                value={skipText}
                onChange={e => {
                  setSkipText(e.target.value);
                }}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
                placeholder="research, design, plan"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || !project.trim()}>
              {props.mode === 'create' ? 'Create' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
