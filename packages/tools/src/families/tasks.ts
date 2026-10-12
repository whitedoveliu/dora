import { statSync } from 'node:fs';
import type { ToolRegistry } from '../registry.ts';
import { bool, define, list, num, opt, requireArg, str, table, type ActionSpec } from './_helpers.ts';

const FAMILY = 'tasks';

const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;

const specs: ActionSpec[] = [
  {
    family: FAMILY,
    name: 'delegate',
    summary: 'Create a task agent for focused work.',
    details: [
      'Conversation context shares a recent dialogue tail, not tool results.',
      'Standing schedules follow the wake styles: a cadence wake takes --schedule-interval; a clock wake takes --schedule-at or --schedule-cron with --schedule-threshold; 0 is an exact wake.',
      'Attachments travel only with --start now and are capped at ' + ATTACH_MAX_FILES + ' files / ' + ATTACH_MAX_BYTES / (1024 * 1024) + ' MB.'
    ],
    trait: 'task_agent.lifecycle',
    options: [
      opt('--attachments', 'string[]', 'Up to ' + ATTACH_MAX_FILES + ' workspace files to transfer into the task agent private filesystem (20.0 MB total). Requires --start now.'),
      opt('--include-conversation-context', 'boolean', 'Share a recent dialogue tail with the task agent'),
      opt('--model-mode', 'string', 'Model to run the task on', { required: true, values: ['fast', 'smart'] }),
      opt('--name', 'string', 'Human-readable handle for the task'),
      opt('--never-expire', 'boolean', 'Keep the task agent alive after it reports'),
      opt('--schedule-at', 'string', 'Local wall-clock time as yyyy-mm-ddThh:mm:ss, no offset, no Z. Requires --schedule-threshold.'),
      opt('--schedule-cron', 'string', 'Cron fields without cron(...): minutes hours day-of-month month day-of-week plus optional year. Requires --schedule-threshold.'),
      opt('--schedule-interval', 'integer', 'Cadence in minutes (5-10080); the first fire lands within one interval.', { min: 5, max: 10080 }),
      opt('--schedule-prompt', 'string', 'Required with any schedule timing. Thin per-wake instruction, not the durable task.'),
      opt('--schedule-threshold', 'integer', 'Minutes of acceptable lateness after each scheduled fire (0-1440).', { min: 0, max: 1440 }),
      opt('--schedule-timezone', 'string', 'Timezone the clock wake is expressed in'),
      opt('--schedule-trigger', 'string', 'Natural-language condition evaluated before each fire'),
      opt('--start', 'string', 'When to start', { values: ['now', 'queued'], default: 'now' }),
      opt('--task', 'string', 'The durable task text', { required: true })
    ],
    outputJson: '{task_session_id:str,name:str,model_mode:str}',
    handler: async (ctx, args) => {
      const mode = requireArg(args, '--model-mode');
      if (mode !== 'fast' && mode !== 'smart') throw new Error('--model-mode must be fast or smart');
      const attachments = list(args, '--attachments');
      const start = (str(args, '--start') ?? 'now') as 'now' | 'queued';
      if (attachments.length > 0 && start !== 'now') throw new Error('--attachments requires --start now');
      if (attachments.length > ATTACH_MAX_FILES) throw new Error('at most ' + ATTACH_MAX_FILES + ' attachments');
      let bytes = 0;
      for (const file of attachments) {
        try {
          bytes += statSync(file).size;
        } catch {
          throw new Error('attachment not found: ' + file);
        }
      }
      if (bytes > ATTACH_MAX_BYTES) throw new Error('attachments exceed 20.0 MB total');

      const interval = num(args, '--schedule-interval');
      const at = str(args, '--schedule-at');
      const cron = str(args, '--schedule-cron');
      const threshold = num(args, '--schedule-threshold');
      const schedulePrompt = str(args, '--schedule-prompt');
      const hasTiming = interval !== null || at !== null || cron !== null;
      if (hasTiming && !schedulePrompt) throw new Error('--schedule-prompt is required with any schedule timing');
      if ((at !== null || cron !== null) && threshold === null) throw new Error('--schedule-at and --schedule-cron require --schedule-threshold');

      const result = await ctx.services.runtime.delegate({
        parentSessionId: ctx.session.id,
        task: requireArg(args, '--task'),
        modelMode: mode,
        name: str(args, '--name') ?? undefined,
        attachments,
        includeConversationContext: bool(args, '--include-conversation-context'),
        start,
        neverExpire: bool(args, '--never-expire'),
        schedule: hasTiming
          ? {
              style: interval !== null ? 'cadence' : at !== null ? 'clock' : 'cron',
              intervalMinutes: interval ?? undefined,
              at: at ?? undefined,
              cron: cron ?? undefined,
              thresholdMinutes: threshold ?? 0,
              timezone: str(args, '--schedule-timezone') ?? undefined,
              trigger: str(args, '--schedule-trigger') ?? undefined,
              prompt: schedulePrompt ?? ''
            }
          : undefined
      });
      return {
        stdout: 'task agent started: ' + result.taskSessionId + '\n',
        json: { task_session_id: result.taskSessionId, name: str(args, '--name') ?? '', model_mode: mode }
      };
    }
  },
  {
    family: FAMILY, name: 'list', summary: 'Task agents this session spawned, with live status.',
    trait: 'task_agent.read',
    outputJson: '{tasks:[{id:str,status:str,name:str}]}',
    handler: async (ctx) => {
      const tasks = ctx.services.runtime.listTasks(ctx.session.id);
      return { stdout: table(tasks, ['id', 'name', 'status', 'model_mode']), json: { tasks } };
    }
  },
  {
    family: FAMILY, name: 'status', summary: 'One task agent in detail.',
    trait: 'task_agent.read',
    options: [opt('--id', 'string', 'Task agent id', { required: true })],
    outputJson: '{id:str,status:str,last_report:str|null}',
    handler: async (ctx, args) => {
      const task = ctx.services.runtime.taskStatus(ctx.session.id, requireArg(args, '--id'));
      if (!task) throw new Error('no task agent with that id');
      return { stdout: JSON.stringify(task) + '\n', json: task };
    }
  },
  {
    family: FAMILY, name: 'cancel', summary: 'Stop a task agent and release its leases. The parent owns cleanup.',
    trait: 'task_agent.lifecycle',
    options: [opt('--id', 'string', 'Task agent id', { required: true })],
    outputJson: '{id:str,cancelled:bool}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const ok = ctx.services.runtime.cancelTask(ctx.session.id, id);
      return { stdout: ok ? 'cancelled ' + id + '\n' : 'no running task ' + id + '\n', json: { id, cancelled: ok } };
    }
  },
  {
    family: FAMILY, name: 'budget', summary: 'Daily window usage for this account.',
    trait: 'task_agent.read',
    outputJson: '{day:str,units:float,limit:float,percent:float}',
    handler: async (ctx) => {
      const b = ctx.services.runtime.budget(ctx.account.id);
      return { stdout: b.day + ': ' + b.units.toFixed(2) + '/' + b.limitUnits + ' units (' + b.percent.toFixed(1) + '%)\n', json: b };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}
