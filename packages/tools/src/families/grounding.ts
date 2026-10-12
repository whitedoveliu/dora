import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ToolRegistry } from '../registry.ts';
import { define, num, opt, requireArg, str, type ActionSpec } from './_helpers.ts';

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml', '.html', '.xml', '.ts', '.js', '.py', '.sh']);
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.pdf', '.docx', '.xlsx', '.pptx']);

const specs: ActionSpec[] = [
  {
    family: 'search',
    name: 'search',
    summary: 'Bounded first-pass search over indexed personal data (observations) and memory.',
    details: ['One bounded pass. If the answer needs more than one pass, delegate the work to a task agent.'],
    trait: 'search',
    options: [
      opt('--query', 'string', 'Search text', { required: true }),
      opt('--scope', 'string', 'Where to look', { values: ['all', 'memory', 'observations'], default: 'all' }),
      opt('--limit', 'integer', 'Maximum hits', { min: 1, max: 50 })
    ],
    outputJson: '{hits:[{where:str,path:str,snippet:str}]}',
    handler: async (ctx, args) => {
      const query = requireArg(args, '--query');
      const scope = str(args, '--scope') ?? 'all';
      const limit = num(args, '--limit') ?? 10;
      const hits: { where: string; path: string; snippet: string }[] = [];
      if (scope === 'all' || scope === 'memory') {
        for (const file of ctx.services.memory.search(query).slice(0, limit)) {
          hits.push({ where: 'memory', path: file.path, snippet: file.body.slice(0, 400) });
        }
      }
      if (scope === 'all' || scope === 'observations') {
        try {
          const rows = ctx.services.observations.sql(
            "SELECT path, substr(body, 1, 400) AS snippet FROM observations_index WHERE body LIKE '%" + query.replace(/'/g, "''") + "%' LIMIT " + limit
          );
          for (const row of rows.rows) hits.push({ where: 'observations', path: String(row['path']), snippet: String(row['snippet']) });
        } catch {
          /* an empty index is not an error */
        }
      }
      const lines = hits.map((h) => '[' + h.where + '] ' + h.path + ' :: ' + h.snippet.replace(/\s+/g, ' ').slice(0, 160));
      return { stdout: (lines.length ? lines.join('\n') : '(no hits)') + '\n', json: { hits: hits.slice(0, limit) } };
    }
  },
  {
    family: 'web_search',
    name: 'search',
    summary: 'Public web search. Every claim that uses it must carry the returned source URLs verbatim.',
    trait: 'search',
    options: [opt('--query', 'string', 'Search query', { required: true }), opt('--limit', 'integer', 'Maximum results', { min: 1, max: 20 })],
    outputJson: '{results:[{title:str,url:str,snippet:str}]}',
    handler: async (ctx, args) => {
      const results = await ctx.services.search.search(requireArg(args, '--query'), { limit: num(args, '--limit') ?? 5 });
      const lines = results.map((r, i) => i + 1 + '. ' + r.title + '\n   ' + r.url + '\n   ' + r.snippet.replace(/\s+/g, ' ').slice(0, 240));
      return { stdout: (lines.length ? lines.join('\n') : '(no results)') + '\n', json: { results } };
    }
  },
  {
    family: 'web_fetch',
    name: 'fetch',
    summary: 'Fetch one public URL and return its text.',
    trait: 'search',
    options: [opt('--url', 'string', 'http(s) URL', { required: true })],
    outputJson: '{url:str,status:int,content_type:str,text:str}',
    handler: async (ctx, args) => {
      const page = await ctx.services.search.fetch(requireArg(args, '--url'));
      return { stdout: page.text.slice(0, 12000), json: page };
    }
  },
  {
    family: 'read',
    name: 'read',
    summary: 'Read a workspace file. Text comes back inline; media and documents come back as an attachment for visual verification.',
    details: ['Plain text goes through bash. This action exists so images, video, PDF and Office files can be looked at.'],
    trait: 'work',
    options: [opt('--path', 'string', 'Workspace path', { required: true }), opt('--max-bytes', 'integer', 'Truncate text at this size', { min: 1, max: 10000000 })],
    outputJson: '{path:str,kind:str,bytes:int}',
    handler: async (ctx, args) => {
      const path = requireArg(args, '--path');
      const info = statSync(path);
      const ext = extname(path).toLowerCase();
      if (MEDIA_EXT.has(ext)) {
        return {
          stdout: 'attached ' + path + ' (' + info.size + ' bytes, ' + ext + ') — inspect it visually before acting.\n',
          json: { path, kind: 'media', bytes: info.size },
          attachments: [{ name: path.split('/').pop() ?? path, kind: 'media', mime: mimeFor(ext), content: path, truncated: false }]
        };
      }
      if (!TEXT_EXT.has(ext)) {
        return { stdout: 'unrecognised file type ' + ext + '; treat as binary.\n', json: { path, kind: 'binary', bytes: info.size } };
      }
      const max = num(args, '--max-bytes') ?? 200000;
      const text = readFileSync(path, 'utf8').slice(0, max);
      return { stdout: text, json: { path, kind: 'text', bytes: info.size } };
    }
  },
  {
    family: 'feedback', name: 'send', summary: 'Send feedback about Dora itself, with the evidence attached.',
    trait: 'search',
    options: [opt('--body', 'string', 'What happened', { required: true }), opt('--kind', 'string', 'Feedback kind', { values: ['bug', 'idea', 'praise'], default: 'bug' })],
    outputJson: '{id:str,kind:str}',
    handler: async (ctx, args) => {
      const id = 'fb_' + Date.now().toString(36);
      ctx.db.prepare('INSERT OR REPLACE INTO kv (k, v, updated_at) VALUES (?, ?, ?)').run('feedback:' + id, JSON.stringify({ body: requireArg(args, '--body'), kind: str(args, '--kind') ?? 'bug', session: ctx.session.id }), Date.now());
      return { stdout: 'recorded ' + id + '\n', json: { id, kind: str(args, '--kind') ?? 'bug' } };
    }
  },
  {
    family: 'feedback', name: 'list', summary: 'Feedback recorded from this account.', trait: 'search',
    outputJson: '{items:[{id:str,kind:str}]}',
    handler: async (ctx) => {
      const rows = ctx.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'feedback:%' ORDER BY updated_at DESC LIMIT 50").all() as { k: string; v: string }[];
      const items = rows.map((r) => ({ id: r.k.replace('feedback:', ''), ...(JSON.parse(r.v) as Record<string, unknown>) }));
      return { stdout: items.map((i) => String(i['id']) + '  ' + String(i['kind'])).join('\n') + '\n', json: { items } };
    }
  },
  {
    family: 'feedback', name: 'status', summary: 'Status of one feedback item.', trait: 'search',
    options: [opt('--id', 'string', 'Feedback id', { required: true })],
    outputJson: '{id:str,state:str}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const row = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('feedback:' + id) as { v: string } | undefined;
      if (!row) throw new Error('no feedback ' + id);
      return { stdout: 'received\n', json: { id, state: 'received' } };
    }
  },
  {
    family: 'account', name: 'info', summary: 'Account identity: handle, display name, plan flags.', trait: 'search',
    outputJson: '{handle:str,display_name:str,member:str}',
    handler: async (ctx) => {
      const info = { handle: ctx.account.handle, display_name: ctx.account.displayName, member: ctx.account.id };
      return { stdout: JSON.stringify(info) + '\n', json: info };
    }
  },
  {
    family: 'account', name: 'contact', summary: 'The member contact details from the account object — never from memory.', trait: 'search',
    outputJson: '{email:str,phone:str,timezone:str}',
    handler: async (ctx) => {
      const contact = { email: ctx.account.email, phone: ctx.account.phone, timezone: ctx.account.timezone };
      return { stdout: JSON.stringify(contact) + '\n', json: contact };
    }
  },
  {
    family: 'skills', name: 'list', summary: 'Skill descriptions available to this role. Descriptions decide when to use a skill; the body says how.',
    trait: 'search',
    outputJson: '{skills:[{id:str,description:str,has_body:bool}]}',
    handler: async (ctx) => {
      const skills = ctx.services.skills.list(ctx.session.role).map((s) => ({ id: s.id, description: s.description, has_body: s.hasBody }));
      return { stdout: skills.map((s) => s.id + ': ' + s.description).join('\n') + '\n', json: { skills } };
    }
  },
  {
    family: 'skills', name: 'read', summary: 'Read a skill body, then the references it names.', trait: 'search',
    options: [opt('--id', 'string', 'Skill id', { required: true }), opt('--reference', 'string', 'Reference file inside the skill')],
    outputJson: '{id:str,body:str,references:[str]}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const reference = str(args, '--reference');
      if (reference) {
        const body = ctx.services.skills.readReference(id, reference, ctx.flags);
        if (body === null) throw new Error('no reference ' + reference + ' in ' + id);
        return { stdout: body, json: { id, body, references: [] } };
      }
      const skill = ctx.services.skills.read(id, ctx.flags);
      if (!skill) throw new Error('no skill ' + id + ' for this role');
      return { stdout: skill.body, json: { id: skill.id, body: skill.body, references: skill.references } };
    }
  }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}

function mimeFor(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}
