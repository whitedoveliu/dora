import type { ToolRegistry } from '../registry.ts';
import { define, list, num, opt, requireArg, str, type ActionSpec } from './_helpers.ts';

/** The four Meta pre-approved templates. */
export const NOTIFY_TEMPLATES: Record<string, string> = {
  task_update: "I finished working on {{1}} - reply here and I'll send the details.",
  follow_up_needed: 'I need one answer from you on {{1}} to keep going - reply here to pick it up.',
  update_ready: "Your {{1}} is ready - reply here and I'll send it over.",
  time_sensitive: "Time-sensitive: {{1}} needs your attention before {{2}} - reply here and I'll explain."
};

export function renderTemplate(template: string, vars: string[]): string {
  return template.replace(/\{\{(\d)\}\}/g, (_m, i: string) => vars[Number(i) - 1] ?? '(missing)');
}

const whatsapp: ActionSpec[] = [
  {
    family: 'whatsappbot',
    name: 'send',
    summary: "Send a WhatsApp message from Dora's own account in the member's conversation.",
    details: [
      'If the 24-hour window is closed, use notify instead: only pre-approved templates may be sent.',
      'Set --reply-to-message-id to quote a wamid; media_paths are workspace files, media_urls are public links.'
    ],
    trait: 'channel.write',
    connector: 'whatsapp',
    options: [
      opt('--body', 'string', 'Message text to send. Required for text messages; optional as a caption with media.'),
      opt('--media-paths', 'string[]', 'Workspace files, sent as separate media messages. Limits: images 5MB, audio/video 16MB, documents 100MB, 100MB total.'),
      opt('--media-urls', 'string[]', 'Public http(s) media URLs, sent separately.'),
      opt('--reply-to-message-id', 'string', 'Inbound wamid to quote-reply to.'),
      opt('--to', 'string', "The connected member's E.164 number from the inbound_whatsapp from attribute.", { required: true }),
      opt('--voice-note', 'boolean', 'Send the sole media_paths item as a voice-note bubble. Requires mono 48 kHz Opus audio (.ogg or .opus).')
    ],
    outputJson: '{to:str,body:str}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('whatsapp');
      if (!channel) throw new Error('whatsapp channel is not enabled for this account');
      const to = requireArg(args, '--to');
      if (!channel.windowOpen(to)) {
        throw new Error('WhatsApp 24-hour window is closed for ' + to + '; use tools whatsappbot notify with a pre-approved template');
      }
      const sent = await channel.send({ to, body: str(args, '--body') ?? '', mediaPaths: list(args, '--media-paths'), replyTo: str(args, '--reply-to-message-id') ?? undefined });
      return { stdout: 'sent (' + sent.id + ')\n', json: { to, body: sent.body } };
    }
  },
  {
    family: 'whatsappbot',
    name: 'notify',
    summary: 'Send one of the four Meta pre-approved templates when the 24-hour window is closed.',
    details: ['Only send a pre-approved template when the result the member asked for cannot be delivered otherwise.'],
    trait: 'channel.write',
    connector: 'whatsapp',
    options: [
      opt('--to', 'string', 'E.164 number', { required: true }),
      opt('--template', 'string', 'Pre-approved template', { required: true, values: Object.keys(NOTIFY_TEMPLATES) }),
      opt('--var', 'string[]', 'Template variables in order ({{1}}, {{2}})')
    ],
    outputJson: '{to:str,template:str,body:str}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('whatsapp');
      if (!channel) throw new Error('whatsapp channel is not enabled for this account');
      const template = requireArg(args, '--template');
      const body = renderTemplate(NOTIFY_TEMPLATES[template] ?? '', list(args, '--var'));
      if (!NOTIFY_TEMPLATES[template]) throw new Error('unknown template: ' + template);
      const sent = await channel.send({ to: requireArg(args, '--to'), body, template });
      return { stdout: 'notify sent (' + sent.id + ')\n', json: { to: sent.to, template, body } };
    }
  },
  {
    family: 'whatsappbot', name: 'status', summary: 'Channel state: whether the 24-hour window is open for an address.',
    trait: 'channel.read', connector: 'whatsapp',
    options: [opt('--to', 'string', 'E.164 number', { required: true })],
    outputJson: '{to:str,window_open:bool}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('whatsapp');
      if (!channel) throw new Error('whatsapp channel is not enabled for this account');
      const to = requireArg(args, '--to');
      const open = channel.windowOpen(to);
      return { stdout: 'window ' + (open ? 'open' : 'closed') + ' for ' + to + '\n', json: { to, window_open: open } };
    }
  },
  {
    family: 'whatsappbot', name: 'read', summary: 'Recent inbound WhatsApp messages.', trait: 'channel.read', connector: 'whatsapp',
    options: [opt('--limit', 'integer', 'How many messages', { min: 1, max: 200 })],
    outputJson: '{messages:[{id:str,from:str,body:str,ts:int}]}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('whatsapp');
      if (!channel) throw new Error('whatsapp channel is not enabled for this account');
      const messages = channel.history(num(args, '--limit') ?? 20);
      return { stdout: messages.map((m) => m.ts + ' ' + m.from + ': ' + m.body).join('\n') + '\n', json: { messages } };
    }
  }
];

const imessage: ActionSpec[] = [
  {
    family: 'imessage', name: 'send', summary: 'Send an iMessage/SMS from the member\'s own line.', trait: 'channel.write', connector: 'imessage',
    details: ['A short message is one bubble. Do not split a sentence across messages.'],
    options: [
      opt('--to', 'string', 'Handle or phone number', { required: true }),
      opt('--body', 'string', 'Message text', { required: true })
    ],
    outputJson: '{to:str,id:str}', 
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('imessage');
      if (!channel) throw new Error('imessage channel is not enabled for this account');
      const sent = await channel.send({ to: requireArg(args, '--to'), body: requireArg(args, '--body') });
      return { stdout: 'sent ' + sent.id + '\n', json: { to: sent.to, id: sent.id } };
    }
  },
  {
    family: 'imessage', name: 'read', summary: 'Recent messages in one thread or across threads.', trait: 'channel.read', connector: 'imessage',
    options: [opt('--thread', 'string', 'Thread handle'), opt('--limit', 'integer', 'How many messages', { min: 1, max: 200 })],
    outputJson: '{messages:[{id:str,from:str,body:str,ts:int}]}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('imessage');
      if (!channel) throw new Error('imessage channel is not enabled for this account');
      const thread = str(args, '--thread');
      const messages = channel.history(num(args, '--limit') ?? 25).filter((m) => !thread || m.threadId === thread || m.from === thread || m.to === thread);
      return { stdout: messages.map((m) => m.ts + ' ' + m.from + ': ' + m.body).join('\n') + '\n', json: { messages } };
    }
  },
  {
    family: 'imessage', name: 'list-threads', summary: 'Threads with recent activity, newest first.', trait: 'channel.read', connector: 'imessage',
    outputJson: '{threads:[{thread_id:str,last_ts:int,unread:int}]}',
    handler: async (ctx) => {
      const channel = ctx.services.channels.get('imessage');
      if (!channel) throw new Error('imessage channel is not enabled for this account');
      const seen = new Map<string, { thread_id: string; last_ts: number; unread: number }>();
      for (const m of channel.history(200)) {
        const key = m.threadId ?? m.from;
        const prev = seen.get(key);
        seen.set(key, { thread_id: key, last_ts: Math.max(prev?.last_ts ?? 0, m.ts), unread: (prev?.unread ?? 0) + (m.direction === 'inbound' ? 1 : 0) });
      }
      const threads = [...seen.values()].sort((a, b) => b.last_ts - a.last_ts);
      return { stdout: threads.map((t) => t.thread_id + '  ' + new Date(t.last_ts).toISOString()).join('\n') + '\n', json: { threads } };
    }
  },
  {
    family: 'imessage', name: 'react', summary: 'Tapback a message.', trait: 'channel.write', connector: 'imessage',
    options: [
      opt('--message-id', 'string', 'Message id to react to', { required: true }),
      opt('--reaction', 'string', 'Reaction', { required: true, values: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'] })
    ],
    outputJson: '{message_id:str,reaction:str}',
    handler: async (_ctx, args) => ({ stdout: 'reacted\n', json: { message_id: requireArg(args, '--message-id'), reaction: requireArg(args, '--reaction') } })
  },
  {
    family: 'imessage', name: 'request-location', summary: 'Ask the member to share their current location.', trait: 'channel.write', connector: 'imessage',
    options: [opt('--to', 'string', 'Handle', { required: true })],
    outputJson: '{requested:bool}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('imessage');
      if (!channel) throw new Error('imessage channel is not enabled for this account');
      await channel.send({ to: requireArg(args, '--to'), body: 'Share your current location when you get a chance.' });
      return { stdout: 'requested\n', json: { requested: true } };
    }
  },
  {
    family: 'imessage', name: 'share-location', summary: 'Send a location pin to a thread.', trait: 'channel.write', connector: 'imessage',
    options: [opt('--to', 'string', 'Handle', { required: true }), opt('--lat', 'string', 'Latitude', { required: true }), opt('--lon', 'string', 'Longitude', { required: true })],
    outputJson: '{sent:bool}',
    handler: async (ctx, args) => {
      const channel = ctx.services.channels.get('imessage');
      if (!channel) throw new Error('imessage channel is not enabled for this account');
      await channel.send({ to: requireArg(args, '--to'), body: 'https://maps.dora.ai/?q=' + requireArg(args, '--lat') + ',' + requireArg(args, '--lon') });
      return { stdout: 'shared\n', json: { sent: true } };
    }
  },
  {
    family: 'imessage', name: 'transcribe', summary: 'Transcribe an audio message received on iMessage.', trait: 'work', connector: 'imessage',
    options: [opt('--message-id', 'string', 'Audio message id', { required: true })],
    outputJson: '{message_id:str,transcript:str}',
    handler: async (_ctx, args) => ({ stdout: '(transcription unavailable: no speech backend configured)\n', json: { message_id: requireArg(args, '--message-id'), transcript: '' } })
  },
  {
    family: 'imessage', name: 'mark-read', summary: 'Mark a thread read.', trait: 'channel.write', connector: 'imessage',
    options: [opt('--thread', 'string', 'Thread handle', { required: true })],
    outputJson: '{thread:str,marked:bool}',
    handler: async (_ctx, args) => ({ stdout: 'marked\n', json: { thread: requireArg(args, '--thread'), marked: true } })
  }
];

const agentMail: ActionSpec[] = [
  {
    family: 'agent-mail', name: 'send', summary: "Send email from Dora's own mailbox with provenance attached.",
    details: ['Email is delegated work: only a task agent sends it, governed by the Email permissions rules.'],
    trait: 'email.send', connector: 'agent-mail',
    options: [
      opt('--to', 'string[]', 'Recipients', { required: true }),
      opt('--subject', 'string', 'Subject', { required: true }),
      opt('--body', 'string', 'Body text', { required: true }),
      opt('--in-reply-to', 'string', 'Message id being answered'),
      opt('--attachments', 'string[]', 'Workspace files to attach')
    ],
    outputJson: '{id:str,to:[str]}',
    handler: async (ctx, args) => {
      const account = ctx.services.connectors.defaultAccount('agent-mail');
      if (!account) throw new Error('agent-mail is not connected');
      const id = 'mail_' + Date.now().toString(36);
      ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)').run('outbox:' + id, JSON.stringify({ to: list(args, '--to'), subject: str(args, '--subject'), body: str(args, '--body') }), Date.now());
      return { stdout: 'queued ' + id + '\n', json: { id, to: list(args, '--to') } };
    }
  },
  {
    family: 'agent-mail', name: 'list', summary: "Inbound mail in Dora's own mailbox.", trait: 'channel.read', connector: 'agent-mail',
    options: [opt('--limit', 'integer', 'How many messages', { min: 1, max: 200 }), opt('--unread-only', 'boolean', 'Only unread')],
    outputJson: '{messages:[{id:str,from:str,subject:str,ts:int}]}',
    handler: async (ctx, args) => {
      const limit = num(args, '--limit') ?? 20;
      const rows = ctx.db.prepare('SELECT k, v FROM kv WHERE k LIKE ? ORDER BY updated_at DESC LIMIT ?').all('inbox:%', limit) as { k: string; v: string }[];
      const messages = rows.map((r) => ({ id: r.k.replace('inbox:', ''), ...(JSON.parse(r.v) as Record<string, unknown>) }));
      return { stdout: messages.map((m) => m['id'] + '  ' + String(m['subject'] ?? '')).join('\n') + '\n', json: { messages } };
    }
  },
  {
    family: 'agent-mail', name: 'read', summary: 'Read one message in full.', trait: 'channel.read', connector: 'agent-mail',
    options: [opt('--id', 'string', 'Message id', { required: true })],
    outputJson: '{id:str,body:str}',
    handler: async (ctx, args) => {
      const id = requireArg(args, '--id');
      const row = ctx.db.prepare('SELECT v FROM kv WHERE k = ?').get('inbox:' + id) as { v: string } | undefined;
      if (!row) throw new Error('no message ' + id);
      const parsed = JSON.parse(row.v) as Record<string, unknown>;
      return { stdout: String(parsed['body'] ?? ''), json: { id, body: String(parsed['body'] ?? '') } };
    }
  },
  {
    family: 'agent-mail', name: 'search', summary: 'Search the agent mailbox.', trait: 'channel.read', connector: 'agent-mail',
    options: [opt('--query', 'string', 'Search text', { required: true })],
    outputJson: '{messages:[{id:str,subject:str}]}',
    handler: async (ctx, args) => {
      const query = requireArg(args, '--query').toLowerCase();
      const rows = ctx.db.prepare('SELECT k, v FROM kv WHERE k LIKE ?').all('inbox:%') as { k: string; v: string }[];
      const messages = rows.filter((r) => r.v.toLowerCase().includes(query)).map((r) => ({ id: r.k.replace('inbox:', ''), ...(JSON.parse(r.v) as Record<string, unknown>) }));
      return { stdout: messages.map((m) => m['id'] + '  ' + String(m['subject'] ?? '')).join('\n') + '\n', json: { messages } };
    }
  },
  {
    family: 'agent-mail', name: 'mark', summary: 'Mark a message read, unread or archived.', trait: 'channel.write', connector: 'agent-mail',
    options: [opt('--id', 'string', 'Message id', { required: true }), opt('--state', 'string', 'New state', { required: true, values: ['read', 'unread', 'archived'] })],
    outputJson: '{id:str,state:str}',
    handler: async (_ctx, args) => ({ stdout: 'marked\n', json: { id: requireArg(args, '--id'), state: requireArg(args, '--state') } })
  },
  {
    family: 'agent-mail', name: 'status', summary: 'Mailbox state: address, unread count, delivery health.', trait: 'channel.read', connector: 'agent-mail',
    outputJson: '{address:str,unread:int}',
    handler: async (ctx) => {
      const account = ctx.services.connectors.defaultAccount('agent-mail');
      const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM kv WHERE k LIKE ?').get('inbox:%') as { n: number };
      return { stdout: (account?.label ?? 'not connected') + '\n', json: { address: account?.label ?? '', unread: Number(rows.n) } };
    }
  },
  {
    family: 'agent-mail', name: 'reply', summary: 'Reply inside an existing thread, preserving provenance.', trait: 'email.send', connector: 'agent-mail',
    options: [
      opt('--id', 'string', 'Message id being replied to', { required: true }),
      opt('--body', 'string', 'Reply body', { required: true })
    ],
    outputJson: '{id:str}',
    handler: async (ctx, args) => {
      const id = 'mail_' + Date.now().toString(36);
      ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)').run('outbox:' + id, JSON.stringify({ in_reply_to: requireArg(args, '--id'), body: str(args, '--body') }), Date.now());
      return { stdout: 'queued ' + id + '\n', json: { id } };
    }
  },
  {
    family: 'agent-mail', name: 'draft', summary: 'Create a draft without sending it.', trait: 'email.send', connector: 'agent-mail',
    options: [opt('--to', 'string[]', 'Recipients', { required: true }), opt('--subject', 'string', 'Subject', { required: true }), opt('--body', 'string', 'Body', { required: true })],
    outputJson: '{id:str}',
    handler: async (ctx, args) => {
      const id = 'draft_' + Date.now().toString(36);
      ctx.db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)').run('draft:' + id, JSON.stringify({ to: list(args, '--to'), subject: str(args, '--subject'), body: str(args, '--body') }), Date.now());
      return { stdout: 'draft ' + id + '\n', json: { id } };
    }
  }
];

export const CHANNEL_SPECS: ActionSpec[] = [...whatsapp, ...imessage, ...agentMail];

export function register(registry: ToolRegistry): void {
  for (const spec of CHANNEL_SPECS) registry.register(define(spec));
}
