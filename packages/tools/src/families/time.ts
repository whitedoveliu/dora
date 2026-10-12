import type { ToolRegistry } from '../registry.ts';
import { define, opt, requireArg, str, type ActionSpec } from './_helpers.ts';

const FAMILY = 'time';

const specs: ActionSpec[] = [
  {
    family: FAMILY,
    name: 'now',
    summary: 'Current time, in the account timezone and in any requested timezone.',
    details: [
      'Every date computation starts here: resolve dates by calculation, not from memory.',
      'The clock in the session context is a record of the last run; this action is the live one.'
    ],
    options: [opt('--timezone', 'string', 'IANA timezone to report (repeatable)')],
    outputJson: '{now:str,timezone:str,unix:int,weekday:str}',
    trait: 'search',
    handler: async (ctx, args) => {
      const now = new Date();
      const tz = str(args, '--timezone') ?? (ctx.account.timezone || 'UTC');
      const fmt = (zone: string) =>
        new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(now);
      const lines = ['now: ' + fmt(tz), 'unix: ' + Math.floor(now.getTime() / 1000)];
      return {
        stdout: lines.join('\n') + '\n',
        json: { now: fmt(tz), timezone: tz, unix: Math.floor(now.getTime() / 1000), weekday: new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long' }).format(now) }
      };
    }
  },
  {
    family: FAMILY,
    name: 'convert',
    summary: 'Convert an instant between timezones.',
    options: [
      opt('--at', 'string', 'ISO instant or yyyy-mm-ddThh:mm:ss', { required: true }),
      opt('--from', 'string', 'Source timezone'),
      opt('--to', 'string', 'Target timezone', { required: true })
    ],
    outputJson: '{from:str,to:str,iso:str}',
    trait: 'search',
    handler: async (_ctx, args) => {
      const at = requireArg(args, '--at');
      const to = requireArg(args, '--to');
      const from = str(args, '--from');
      const date = new Date(from ? at + ' ' + from : at);
      if (Number.isNaN(date.getTime())) throw new Error('could not parse --at: ' + at);
      const iso = new Intl.DateTimeFormat('en-CA', { timeZone: to, dateStyle: 'full', timeStyle: 'long' }).format(date);
      return { stdout: iso + '\n', json: { from: from ?? 'local', to, iso } };
    }
  },
  {
    family: FAMILY,
    name: 'diff',
    summary: 'Duration between two instants, in human units.',
    options: [
      opt('--from', 'string', 'Start instant', { required: true }),
      opt('--to', 'string', 'End instant', { required: true })
    ],
    outputJson: '{minutes:int,human:str}',
    trait: 'search',
    handler: async (_ctx, args) => {
      const from = new Date(requireArg(args, '--from'));
      const to = new Date(requireArg(args, '--to'));
      const ms = to.getTime() - from.getTime();
      if (Number.isNaN(ms)) throw new Error('unparseable instant');
      const minutes = Math.round(ms / 60000);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const human = [days > 0 ? days + 'd' : '', hours > 0 ? hours + 'h' : '', (minutes % 60) + 'm'].filter(Boolean).join(' ');
      return { stdout: human + '\n', json: { minutes, human } };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}
