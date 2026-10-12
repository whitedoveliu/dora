import type { ToolRegistry } from '../registry.ts';
import { define, num, opt, requireArg, str, table, type ActionSpec } from './_helpers.ts';

const FAMILY = 'todos';

const specs: ActionSpec[] = [
  {
    family: FAMILY, name: 'list', summary: 'Durable outcome-tracking todos for this account.',
    trait: 'todos.read',
    options: [opt('--status', 'string', 'Filter by status', { values: ['open', 'done', 'dropped'] })],
    outputJson: '{todos:[{id:str,title:str,status:str,due_at:int|null}]}',
    handler: async (ctx, args) => {
      const status = str(args, '--status');
      const all = ctx.services.runtime.todos.list(ctx.account.id);
      const rows = (status ? all.filter((t) => t.status === status) : all).map((t) => ({
        id: t.id, title: t.title, status: t.status, due_at: t.dueAt
      }));
      return { stdout: table(rows, ['id', 'title', 'status', 'due_at']), json: { todos: rows } };
    }
  },
  {
    family: FAMILY, name: 'create', summary: 'Create a durable todo.',
    details: ['Only the main agent mutates todos; a task agent proposes them to its parent.'],
    trait: 'todos.write',
    options: [
      opt('--title', 'string', 'What outcome is tracked', { required: true }),
      opt('--due-at', 'string', 'ISO instant the outcome is due'),
      opt('--notes', 'string', 'Free-form notes')
    ],
    outputJson: '{id:str,title:str,status:str}',
    handler: async (ctx, args) => {
      const due = str(args, '--due-at');
      const todo = ctx.services.runtime.todos.create(ctx.account.id, {
        title: requireArg(args, '--title'),
        dueAt: due ? new Date(due).getTime() : null,
        notes: str(args, '--notes') ?? '',
        sessionId: ctx.session.id
      });
      return { stdout: 'created ' + todo.id + '\n', json: { id: todo.id, title: todo.title, status: todo.status } };
    }
  },
  {
    family: FAMILY, name: 'update', summary: 'Update title, status, due date or notes of a todo.',
    trait: 'todos.write',
    options: [
      opt('--id', 'string', 'Todo id', { required: true }),
      opt('--title', 'string', 'New title'),
      opt('--status', 'string', 'New status', { values: ['open', 'done', 'dropped'] }),
      opt('--due-at', 'string', 'New due instant'),
      opt('--notes', 'string', 'New notes')
    ],
    outputJson: '{id:str,status:str}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const due = str(args, '--due-at');
      const status = str(args, '--status') as 'open' | 'done' | 'dropped' | null;
      const updated = ctx.services.runtime.todos.update(id, {
        title: str(args, '--title') ?? undefined,
        status: status ?? undefined,
        dueAt: due ? new Date(due).getTime() : undefined,
        notes: str(args, '--notes') ?? undefined
      });
      if (!updated) throw new Error('no todo with id ' + id);
      return { stdout: 'updated ' + id + '\n', json: { id, status: updated.status } };
    }
  },
  {
    family: FAMILY, name: 'complete', summary: 'Mark a todo done.', trait: 'todos.write',
    options: [opt('--id', 'string', 'Todo id', { required: true })],
    outputJson: '{id:str,status:str}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const updated = ctx.services.runtime.todos.update(id, { status: 'done' });
      if (!updated) throw new Error('no todo with id ' + id);
      return { stdout: 'done ' + id + '\n', json: { id, status: 'done' } };
    }
  },
  {
    family: FAMILY, name: 'drop', summary: 'Drop a todo without completing it.', trait: 'todos.write',
    options: [opt('--id', 'string', 'Todo id', { required: true }), opt('--reason', 'string', 'Why it is dropped')],
    outputJson: '{id:str,status:str}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const updated = ctx.services.runtime.todos.update(id, { status: 'dropped', notes: str(args, '--reason') ?? undefined });
      if (!updated) throw new Error('no todo with id ' + id);
      return { stdout: 'dropped ' + id + '\n', json: { id, status: 'dropped' } };
    }
  },
  {
    family: FAMILY, name: 'get', summary: 'Read one todo.', trait: 'todos.read',
    options: [opt('--id', 'string', 'Todo id', { required: true })],
    outputJson: '{id:str,title:str,status:str,notes:str}',
    handler: async (ctx, args) => {
      const todo = ctx.services.runtime.todos.get(requireArg(args, '--id'));
      if (!todo) throw new Error('no todo with that id');
      return { stdout: todo.title + ' [' + todo.status + ']\n', json: { ...todo } };
    }
  },
  {
    family: FAMILY, name: 'stats', summary: 'Counts by status and overdue count.', trait: 'todos.read',
    outputJson: '{open:int,done:int,dropped:int,overdue:int}',
    handler: async (ctx) => {
      const all = ctx.services.runtime.todos.list(ctx.account.id);
      const now = Date.now();
      const stats = {
        open: all.filter((t) => t.status === 'open').length,
        done: all.filter((t) => t.status === 'done').length,
        dropped: all.filter((t) => t.status === 'dropped').length,
        overdue: all.filter((t) => t.status === 'open' && t.dueAt !== null && t.dueAt < now).length
      };
      void num;
      return { stdout: JSON.stringify(stats) + '\n', json: stats };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}
