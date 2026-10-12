import type { ToolRegistry } from '../registry.ts';
import { define, list, opt, requireArg, str, type ActionSpec } from './_helpers.ts';

const specs: ActionSpec[] = [
  {
    family: 'agent_message',
    name: 'send',
    summary: 'Send a message from a task agent to its parent. The report carries results, not the trail.',
    details: [
      'A report carries results and attachments; it does not carry the tool-call trail or the filesystem.',
      'The parent receives the results first, then owns cleanup.'
    ],
    trait: 'orchestration',
    options: [
      opt('--body', 'string', 'Message text', { required: true }),
      opt('--attachments', 'string[]', 'Workspace files to hand to the parent')
    ],
    outputJson: '{delivered:bool}',
    handler: async (ctx, args) => {
      if (ctx.session.kind !== 'task') throw new Error('agent_message.send is only available to a task agent reporting to its parent');
      const result = await ctx.services.runtime.sendToParent(ctx.session.id, requireArg(args, '--body'), list(args, '--attachments'));
      void str;
      return { stdout: result.delivered ? 'delivered\n' : 'not delivered (no parent session)\n', json: result };
    }
  },
  {
    family: 'wake_schedule',
    name: 'create',
    summary: 'Schedule a wake for this session: a cadence, a clock time, or a cron expression.',
    details: [
      'A clock wake (--at or --schedule-cron) must carry --schedule-threshold, the lateness the member tolerates; 0 is exact.',
      '--schedule-trigger is a natural-language condition the platform evaluates before the fire; a failed condition skips the run rather than failing it.'
    ],
    trait: 'wake.schedule',
    options: [
      opt('--schedule-interval', 'integer', 'Cadence in minutes (5-10080)', { min: 5, max: 10080 }),
      opt('--at', 'string', 'Local wall-clock time yyyy-mm-ddThh:mm:ss'),
      opt('--schedule-cron', 'string', 'Cron fields without cron(...)'),
      opt('--schedule-threshold', 'integer', 'Minutes of acceptable lateness (0-1440)', { min: 0, max: 1440 }),
      opt('--schedule-timezone', 'string', 'Timezone of the clock time'),
      opt('--schedule-trigger', 'string', 'Natural-language condition evaluated before the fire'),
      opt('--prompt', 'string', 'Thin per-wake instruction, not the durable task', { required: true })
    ],
    outputJson: '{id:str,next_fire_at:int}',
    handler: async (ctx, args) => {
      const interval = args['--schedule-interval'] as number | undefined;
      const at = str(args, '--at');
      const cron = str(args, '--schedule-cron');
      const threshold = (args['--schedule-threshold'] as number | undefined) ?? 0;
      const timings = [interval !== undefined, at !== null, cron !== null].filter(Boolean).length;
      if (timings !== 1) throw new Error('provide exactly one of --schedule-interval, --at, --schedule-cron');
      if ((at !== null || cron !== null) && args['--schedule-threshold'] === undefined) {
        throw new Error('--at and --schedule-cron require --schedule-threshold');
      }
      const wake = ctx.services.runtime.createWake(ctx.session.id, {
        style: interval !== undefined ? 'cadence' : at !== null ? 'clock' : 'cron',
        intervalMinutes: interval,
        at: at ?? undefined,
        cron: cron ?? undefined,
        thresholdMinutes: threshold,
        timezone: str(args, '--schedule-timezone') ?? undefined,
        trigger: str(args, '--schedule-trigger') ?? undefined,
        prompt: requireArg(args, '--prompt')
      });
      return { stdout: 'scheduled ' + wake.id + ' (next fire ' + new Date(wake.nextFireAt).toISOString() + ')\n', json: wake };
    }
  },
  {
    family: 'wake_schedule', name: 'list', summary: 'Wakes owned by this session.', trait: 'wake.schedule',
    outputJson: '{wakes:[{id:str,style:str,next_fire_at:int|null}]}',
    handler: async (ctx) => {
      const wakes = ctx.services.runtime.listWakes(ctx.session.id);
      const lines = wakes.map((w) => w.id + '  ' + w.style + '  next=' + (w.nextFireAt ? new Date(w.nextFireAt).toISOString() : 'none') + (w.trigger ? '  trigger=' + w.trigger : ''));
      return { stdout: (lines.length ? lines.join('\n') : '(no wakes)') + '\n', json: { wakes } };
    }
  },
  {
    family: 'wake_schedule', name: 'cancel', summary: 'Cancel a wake by id.', trait: 'wake.schedule',
    options: [opt('--id', 'string', 'Wake id', { required: true })],
    outputJson: '{id:str,cancelled:bool}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const ok = ctx.services.runtime.cancelWake(ctx.session.id, id);
      return { stdout: ok ? 'cancelled ' + id + '\n' : 'no wake ' + id + '\n', json: { id, cancelled: ok } };
    }
  },
  {
    family: 'wake_schedule', name: 'update', summary: 'Retime or disable a wake.', trait: 'wake.schedule',
    options: [
      opt('--id', 'string', 'Wake id', { required: true }),
      opt('--enable', 'boolean', 'Enable the wake'),
      opt('--schedule-interval', 'integer', 'New cadence in minutes', { min: 5, max: 10080 })
    ],
    outputJson: '{id:str,updated:bool}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const enable = args['--enable'];
      const interval = args['--schedule-interval'] as number | undefined;
      const updated = ctx.services.runtime.updateWake?.(ctx.session.id, id, {
        enabled: enable === undefined ? undefined : enable === true,
        intervalMinutes: interval
      }) ?? false;
      return { stdout: updated ? 'updated ' + id + '\n' : 'no wake ' + id + '\n', json: { id, updated } };
    }
  },
  {
    family: 'wake_subscription',
    name: 'subscribe',
    summary: 'Subscribe this session to an event source. Task agents only.',
    details: [
      'Supported sources: gmail, google-calendar, google-docs, location, imessage.',
      'Every subscription carries an automatic safety check-in that bypasses the trigger filter; you do not pair it with your own timeout.'
    ],
    trait: 'wake.subscription',
    options: [
      opt('--source', 'string', 'Event source', { required: true, values: ['gmail', 'google-calendar', 'google-docs', 'location', 'imessage'] }),
      opt('--filter', 'string', 'Narrowing expression, e.g. from:boss@example.com'),
      opt('--check-in-frequency-minutes', 'integer', 'Silence before the platform safety check-in fires', { min: 60, max: 43200 })
    ],
    outputJson: '{id:str,source:str,check_in_frequency_minutes:int}',
    handler: async (ctx, args) => {
      const source = requireArg(args, '--source') as 'gmail' | 'google-calendar' | 'google-docs' | 'location' | 'imessage';
      const sub = ctx.services.runtime.subscribe(ctx.session.id, {
        source,
        filter: str(args, '--filter') ?? undefined,
        checkInFrequencyMinutes: (args['--check-in-frequency-minutes'] as number | undefined) ?? 1440
      });
      return { stdout: 'subscribed ' + sub.id + ' to ' + sub.source + '\n', json: sub };
    }
  },
  {
    family: 'wake_subscription', name: 'list', summary: 'Subscriptions owned by sessions in this account.', trait: 'wake.subscription',
    outputJson: '{subscriptions:[{id:str,source:str,enabled:bool}]}',
    handler: async (ctx) => {
      const subs = ctx.services.runtime.listSubscriptions(ctx.session.id);
      return { stdout: (subs.length ? subs.map((s) => s.id + '  ' + s.source + '  ' + (s.enabled ? 'enabled' : 'disabled')).join('\n') : '(no subscriptions)') + '\n', json: { subscriptions: subs } };
    }
  },
  {
    family: 'wake_subscription', name: 'unsubscribe', summary: 'Cancel a subscription. Subscriptions do not expire on their own.', trait: 'wake.subscription',
    options: [opt('--id', 'string', 'Subscription id', { required: true })],
    outputJson: '{id:str,unsubscribed:bool}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const ok = ctx.services.runtime.unsubscribe(ctx.session.id, id);
      return { stdout: ok ? 'unsubscribed ' + id + '\n' : 'no subscription ' + id + '\n', json: { id, unsubscribed: ok } };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}
