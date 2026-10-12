import type { ToolRegistry } from '../registry.ts';
import { define, num, opt, requireArg, str, table, type ActionSpec } from './_helpers.ts';

const specs: ActionSpec[] = [
  {
    family: 'observations',
    name: 'sql',
    summary: 'Structured query over the observation index: SELECT/WITH only.',
    details: [
      'Hard limits: 3 second timeout, 10000 row cap, no OFFSET.',
      'A query over a month-partitioned table must carry a timestamp condition.',
      'Never browse the observation directory with shell commands; this is the audited path.'
    ],
    trait: 'search',
    options: [
      opt('--query', 'string', 'SQL text; SELECT or WITH only', { required: true }),
      opt('--limit', 'integer', 'Row cap for this query', { min: 1, max: 10000 })
    ],
    outputJson: '{columns:[str],rows:[[any]],truncated:bool}',
    handler: async (ctx, args) => {
      const query = requireArg(args, '--query');
      const limit = num(args, '--limit');
      const result = ctx.services.observations.sql(limit ? query + ' LIMIT ' + limit : query);
      const rows = result.rows.map((r) => result.columns.map((c) => r[c]));
      const rendered = table(
        result.rows.map((r) => Object.fromEntries(result.columns.map((c) => [c, r[c]]))),
        result.columns
      );
      return {
        stdout: rendered + (result.truncated ? '[truncated at the row cap]\n' : '') + '(' + result.rows.length + ' rows in ' + result.ms + ' ms)\n',
        json: { columns: result.columns, rows, truncated: result.truncated }
      };
    }
  },
  {
    family: 'observations',
    name: 'fetch',
    summary: 'Read one observation document in full by path.',
    trait: 'search',
    options: [opt('--path', 'string', 'Observation path', { required: true })],
    outputJson: '{path:str,mime:str,content:str}',
    handler: async (ctx, args) => {
      const path = requireArg(args, '--path');
      const doc = ctx.services.observations.fetch(path);
      if (!doc) throw new Error('no observation at ' + path);
      return { stdout: doc.content.slice(0, 20000), json: { path: doc.path, mime: doc.mime, content: doc.content } };
    }
  },
  {
    family: 'vault',
    name: 'list',
    summary: 'List vault items: labels, kinds and field names. Values are never returned.',
    trait: 'search',
    outputJson: '{items:[{id:str,label:str,kind:str,fields:[str]}]}',
    handler: async (ctx) => {
      const items = ctx.services.vault.list();
      return { stdout: table(items, ['id', 'label', 'kind']), json: { items } };
    }
  },
  {
    family: 'vault', name: 'status', summary: 'One vault item: existence, kind, fields, last update.', trait: 'search',
    options: [opt('--id', 'string', 'Vault item id', { required: true })],
    outputJson: '{id:str,label:str,kind:str,updated_at:int}',
    handler: async (ctx, args) => {
      const item = ctx.services.vault.status(requireArg(args, '--id'));
      if (!item) throw new Error('no vault item with that id');
      return { stdout: item.label + ' (' + item.kind + '), fields: ' + item.fields.join(', ') + '\n', json: item };
    }
  },
  {
    family: 'vault',
    name: 'link',
    summary: 'Send the member a single-use secure link to store a secret. Passwords and card numbers never travel through chat.',
    details: [
      'The member fills the form outside the channel; you receive a notification that the item exists, never its values.'
    ],
    trait: 'channel.write',
    options: [
      opt('--label', 'string', 'What the item is for', { required: true }),
      opt('--kind', 'string', 'Item kind', { required: true, values: ['password', 'card', 'address', 'phone', 'identity', 'note'] }),
      opt('--fields', 'string[]', 'Field names the member must fill', { required: true }),
      opt('--ttl-minutes', 'integer', 'Link lifetime', { min: 5, max: 10080 }),
      opt('--send-to', 'string', 'Channel address to deliver the link to')
    ],
    outputJson: '{token:str,url:str,expires_at:int,sent:bool}',
    handler: async (ctx, args) => {
      const link = ctx.services.vault.createFillLink({
        label: requireArg(args, '--label'),
        kind: requireArg(args, '--kind') as 'password' | 'card' | 'address' | 'phone' | 'identity' | 'note',
        fields: (args['--fields'] as string[]) ?? [],
        ttlMinutes: num(args, '--ttl-minutes') ?? undefined
      });
      const to = str(args, '--send-to') ?? ctx.account.phone ?? ctx.account.email;
      let sent = false;
      try {
        await ctx.services.channels.deliver(ctx.session, 'Secure link to store "' + requireArg(args, '--label') + '": ' + link.url);
        sent = true;
      } catch {
        sent = false;
      }
      return { stdout: 'fill link created (expires ' + new Date(link.expiresAt).toISOString() + '), delivered=' + sent + '\n', json: { ...link, sent } };
    }
  },
  {
    family: 'vault',
    name: 'fill',
    summary: 'Place a stored value into a page field. The model learns that it happened, never the value.',
    trait: 'work',
    options: [
      opt('--id', 'string', 'Vault item id', { required: true }),
      opt('--site', 'string', 'Site the value is being placed into', { required: true }),
      opt('--field', 'string', 'Field name or ref on the page', { required: true })
    ],
    outputJson: '{filled:bool,item_id:str,fields:int}',
    handler: async (ctx, args) => {
      const result = ctx.services.vault.fill(requireArg(args, '--id'), { site: requireArg(args, '--site'), field: requireArg(args, '--field') });
      return { stdout: 'filled 1 field on ' + str(args, '--site') + '\n', json: { filled: true, item_id: result.itemId, fields: result.fields } };
    }
  },
  {
    family: 'vault', name: 'delete', summary: 'Delete a stored item. Requires an explicit member request.', trait: 'channel.write',
    options: [opt('--id', 'string', 'Vault item id', { required: true }), opt('--reason', 'string', 'Member request that authorises the deletion')],
    outputJson: '{id:str,deleted:bool}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const reason = str(args, '--reason');
      if (!reason) throw new Error('deleting a vault item needs --reason quoting the member request');
      const ok = ctx.services.vault.remove(id);
      return { stdout: ok ? 'deleted ' + id + '\n' : 'no item ' + id + '\n', json: { id, deleted: ok } };
    }
  },
  {
    family: 'vault', name: 'note', summary: 'Attach a non-secret note to a vault item (for example: rotated, expired).', trait: 'search',
    options: [opt('--id', 'string', 'Vault item id', { required: true }), opt('--note', 'string', 'Non-secret note', { required: true })],
    outputJson: '{id:str,updated:bool}',
    handler: async (ctx, args) => {
      const updated = ctx.services.vault.touchNote(requireArg(args, '--id'), requireArg(args, '--note'));
      return { stdout: updated ? 'noted\n' : 'no item\n', json: { id: requireArg(args, '--id'), updated: updated !== null } };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}
