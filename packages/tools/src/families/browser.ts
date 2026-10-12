import type { ToolRegistry } from '../registry.ts';
import type { ActionContext, ActionResult } from '../contract.ts';
import { define, num, opt, requireArg, str, type ActionSpec } from './_helpers.ts';

/**
 * Rented-browser surface.
 *
 * Two permissions are separate: holding a readable lease and driving the browser. A
 * guidance token from browser_guidance.search is carried into acquire, which turns
 * "read the field notes before you act" into a data-flow constraint instead of advice.
 */

async function drive(ctx: ActionContext, leaseId: string, command: Record<string, unknown>): Promise<ActionResult> {
  const result = await ctx.services.browser.drive(leaseId, command);
  return {
    stdout: result.stdout,
    json: { lease_id: leaseId, op: command['op'], ok: result.ok },
    attachments: result.attachment ? [result.attachment] : undefined
  };
}

const scheduler: ActionSpec[] = [
  {
    family: 'cloud_browser_scheduler',
    name: 'acquire',
    summary: 'Acquire a browser lease: read or write, for one site.',
    details: [
      'Read leases and driving are separate permissions; a lease also has to exist before any cloud_browser action runs.',
      'A shared write lease is coordinated by the main agent; task agents acquire and drive their own.'
    ],
    trait: 'resource.lifecycle',
    connector: 'cloud_browser',
    options: [
      opt('--kind', 'string', 'Lease kind', { required: true, values: ['read', 'write'] }),
      opt('--site', 'string', 'Site the lease is for'),
      opt('--guidance-token', 'string', 'Token returned by browser_guidance.search'),
      opt('--ttl-minutes', 'integer', 'Lease lifetime', { min: 1, max: 240 })
    ],
    outputJson: '{lease_id:str,expires_at:int}',
    handler: async (ctx, args) => {
      const lease = ctx.services.browser.acquire({
        sessionId: ctx.session.id,
        kind: requireArg(args, '--kind') as 'read' | 'write',
        site: str(args, '--site') ?? undefined,
        guidanceToken: str(args, '--guidance-token') ?? undefined,
        ttlMinutes: num(args, '--ttl-minutes') ?? undefined
      });
      return {
        stdout: 'lease ' + lease.id + ' until ' + new Date(lease.expiresAt).toISOString() + '\n',
        json: { lease_id: lease.id, expires_at: lease.expiresAt }
      };
    }
  },
  {
    family: 'cloud_browser_scheduler', name: 'release', summary: 'Release a lease (the main agent may release any lease).',
    trait: 'resource.lifecycle', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true })],
    outputJson: '{released:bool}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--lease-id');
      const ok = ctx.services.browser.release(id, ctx.session.id);
      return { stdout: ok ? 'released ' + id + '\n' : 'no lease ' + id + '\n', json: { released: ok } };
    }
  },
  {
    family: 'cloud_browser_scheduler', name: 'extend', summary: 'Extend a lease you hold.',
    trait: 'resource.lifecycle', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true }), opt('--minutes', 'integer', 'Extra minutes', { required: true, min: 1, max: 240 })],
    outputJson: '{lease_id:str,expires_at:int}',
    handler: async (ctx, args) => {
      const lease = ctx.services.browser.extend(requireArg(args, '--lease-id'), ctx.session.id, num(args, '--minutes') ?? 15);
      return { stdout: 'extended to ' + new Date(lease.expiresAt).toISOString() + '\n', json: { lease_id: lease.id, expires_at: lease.expiresAt } };
    }
  },
  {
    family: 'cloud_browser_scheduler', name: 'status', summary: 'State of one lease, or of every lease this account holds.',
    trait: 'resource.lifecycle', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id')],
    outputJson: '{leases:[{lease_id:str,kind:str,expires_at:int}]}',
    handler: async (ctx, args) => {
      const id = str(args, '--lease-id');
      const leases = id ? [ctx.services.browser.status(id)].filter((l) => l !== null) : ctx.services.browser.leases();
      return {
        stdout: leases.map((l) => l!.id + ' ' + l!.kind + ' until ' + new Date(l!.expiresAt).toISOString()).join('\n') + '\n',
        json: { leases }
      };
    }
  }
];

const browserActions: ActionSpec[] = [
  {
    family: 'cloud_browser', name: 'open', summary: 'Open a URL inside a browser lease.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true }), opt('--url', 'string', 'URL to open', { required: true })],
    outputJson: '{url:str,title:str}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'open', url: requireArg(args, '--url') })
  },
  {
    family: 'cloud_browser', name: 'snapshot', summary: 'Snapshot the page: elements with refs valid for this snapshot only.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true })],
    outputJson: '{refs:[{ref:str,role:str,name:str}],text:str}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'snapshot' })
  },
  {
    family: 'cloud_browser', name: 'click', summary: 'Click an element by ref from the latest snapshot. A stale ref is re-read, never retried.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true }), opt('--ref', 'string', 'Element ref', { required: true })],
    outputJson: '{ok:bool,url:str}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'click', ref: requireArg(args, '--ref') })
  },
  {
    family: 'cloud_browser', name: 'type', summary: 'Type into an element by ref. Secrets go through vault.fill, never through --text.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [
      opt('--lease-id', 'string', 'Lease id', { required: true }),
      opt('--ref', 'string', 'Element ref', { required: true }),
      opt('--text', 'string', 'Text to type'),
      opt('--submit', 'boolean', 'Submit after typing')
    ],
    outputJson: '{ok:bool}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'type', ref: requireArg(args, '--ref'), text: str(args, '--text') ?? '', submit: args['--submit'] === true })
  },
  {
    family: 'cloud_browser', name: 'press', summary: 'Press a key in the page.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true }), opt('--key', 'string', 'Key name', { required: true })],
    outputJson: '{ok:bool}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'press', key: requireArg(args, '--key') })
  },
  {
    family: 'cloud_browser', name: 'read', summary: 'Read the page text, or one region of it.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true }), opt('--ref', 'string', 'Limit to one element')],
    outputJson: '{text:str}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'read', ref: str(args, '--ref') ?? null })
  },
  {
    family: 'cloud_browser', name: 'current-url', summary: 'The real URL after a navigation — the verification step after a click.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true })],
    outputJson: '{url:str,title:str}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'current-url' })
  },
  {
    family: 'cloud_browser', name: 'screenshot', summary: 'Screenshot the page and attach it for visual verification.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true }), opt('--full-page', 'boolean', 'Capture the whole page')],
    outputJson: '{path:str}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'screenshot', fullPage: args['--full-page'] === true })
  },
  {
    family: 'cloud_browser', name: 'scroll', summary: 'Scroll the page.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [
      opt('--lease-id', 'string', 'Lease id', { required: true }),
      opt('--direction', 'string', 'Direction', { values: ['up', 'down'], default: 'down' }),
      opt('--pages', 'integer', 'How many viewports', { min: 1, max: 10 })
    ],
    outputJson: '{ok:bool}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'scroll', direction: str(args, '--direction') ?? 'down', pages: num(args, '--pages') ?? 1 })
  },
  {
    family: 'cloud_browser', name: 'wait', summary: 'Wait for a condition on the page.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [
      opt('--lease-id', 'string', 'Lease id', { required: true }),
      opt('--for', 'string', 'What to wait for', { values: ['navigation', 'idle', 'selector'], default: 'idle' }),
      opt('--selector', 'string', 'Selector when --for selector')
    ],
    outputJson: '{ok:bool}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'wait', for: str(args, '--for') ?? 'idle', selector: str(args, '--selector') })
  },
  {
    family: 'cloud_browser', name: 'list', summary: 'Open pages inside a lease.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true })],
    outputJson: '{pages:[{url:str,title:str}]}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'list' })
  },
  {
    family: 'cloud_browser', name: 'close', summary: 'Close the page (the lease stays alive).',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--lease-id', 'string', 'Lease id', { required: true })],
    outputJson: '{closed:bool}',
    handler: async (ctx, args) => drive(ctx, requireArg(args, '--lease-id'), { op: 'close' })
  }
];

const guidance: ActionSpec[] = [
  {
    family: 'browser_guidance', name: 'search', summary: 'Field notes for a site and flow. Returns a guidance token that acquire requires.',
    details: ['Missing guidance means unknown — it is neither support nor prohibition.'],
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [opt('--site', 'string', 'Site', { required: true }), opt('--flow', 'string', 'Flow name, e.g. checkout')],
    outputJson: '{token:str,entries:[{id:str,outcome:str,notes:str}]}',
    handler: async (ctx, args) => {
      const result = ctx.services.browser.guidance.search({ site: requireArg(args, '--site'), flow: str(args, '--flow') ?? undefined });
      if (!result) throw new Error('no guidance for that site');
      return { stdout: result.entries.map((e) => e.id + ' ' + e.outcome + ' ' + e.notes).join('\n') + '\n', json: result };
    }
  },
  {
    family: 'browser_guidance', name: 'record', summary: 'Record how a flow went, so the next run has field notes.',
    trait: 'browser.drive', connector: 'cloud_browser',
    options: [
      opt('--site', 'string', 'Site', { required: true }),
      opt('--flow', 'string', 'Flow name', { required: true }),
      opt('--outcome', 'string', 'Result', { required: true, values: ['success', 'failure'] }),
      opt('--notes', 'string', 'What happened, concretely', { required: true })
    ],
    outputJson: '{id:str}',
    handler: async (ctx, args) => {
      const recorded = ctx.services.browser.guidance.record({
        site: requireArg(args, '--site'),
        flow: requireArg(args, '--flow'),
        outcome: requireArg(args, '--outcome') as 'success' | 'failure',
        notes: requireArg(args, '--notes')
      });
      return { stdout: 'recorded ' + recorded.id + '\n', json: recorded };
    }
  },
  {
    family: 'browser_guidance', name: 'list', summary: 'Everything known about the sites this account has touched.',
    trait: 'browser.drive', connector: 'cloud_browser',
    outputJson: '{entries:[{site:str,flow:str,outcome:str}]}',
    handler: async (ctx) => {
      const entries = ctx.services.browser.guidance.list();
      return { stdout: entries.map((e) => e.site + ' ' + e.flow + ' ' + e.outcome).join('\n') + '\n', json: { entries } };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of [...scheduler, ...browserActions, ...guidance]) registry.register(define(spec));
}
