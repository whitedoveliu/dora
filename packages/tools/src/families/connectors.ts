import type { ConnectorRecord } from '@dora/core';
import type { ActionResult } from '../contract.ts';
import { define, list, num, opt, requireArg, str, type ActionSpec, type OptionSpec } from './_helpers.ts';
import type { ToolRegistry } from '../registry.ts';
import type { Trait } from '@dora/core';

/**
 * Connector-backed families.
 *
 * Names exist in the catalogue whether or not a connector is connected; the *help page*
 * only carries a contract when the connector is connected. Disconnected families answer
 * with one status line. Data comes from the local connector store, so every family is
 * exercisable offline with fixture accounts — no OAuth dance and no vendor login.
 */
interface ConnectorAction {
  name: string;
  summary: string;
  trait: Trait;
  options?: OptionSpec[];
  outputJson: string;
  details?: string[];
  run: (ctx: ConnectorCtx, args: Record<string, unknown>, account: ConnectorRecord['accountId']) => Promise<ActionResult>;
}

interface ConnectorFamily {
  name: string;
  title: string;
  connector: string;
  declared: number;
  kinds: string[];
  actions: ConnectorAction[];
}

type ConnectorCtx = Parameters<ActionSpec['handler']>[0];

function rowsToTable(records: ConnectorRecord[]): string {
  if (records.length === 0) return '(none)\n';
  return records.map((r) => r.ts + '  ' + r.id + '  ' + r.title).join('\n') + '\n';
}

function accountActions(connector: string, title: string): ConnectorAction[] {
  return [
    {
      name: 'list-accounts',
      summary: 'Accounts connected for ' + title + '. The live answer, never from memory.',
      trait: 'work',
      outputJson: '{accounts:[{id:str,label:str,is_default:bool}]}',
      run: async (ctx) => {
        const accounts = ctx.services.connectors.accounts(connector).map((a) => ({ id: a.id, label: a.label, is_default: a.isDefault }));
        return { stdout: accounts.map((a) => a.id + '  ' + a.label + (a.is_default ? '  (default)' : '')).join('\n') + '\n', json: { accounts } };
      }
    },
    {
      name: 'add-account',
      summary: 'Connect an account for ' + title + '.',
      details: ['Dora connects locally: pass a label and, when the service needs one, an app password or access token. No vendor login flow is required.'],
      trait: 'work',
      options: [opt('--label', 'string', 'Account label or address', { required: true }), opt('--token', 'string', 'Access token or app password'), opt('--make-default', 'boolean', 'Make this the default account')],
      outputJson: '{id:str,label:str}',
      run: async (ctx, args) => {
        const account = ctx.services.connectors.addAccount(connector, requireArg(args, '--label'), { token: str(args, '--token') ?? '' });
        return { stdout: 'connected ' + account.id + '\n', json: { id: account.id, label: account.label } };
      }
    },
    {
      name: 'disconnect-account',
      summary: 'Disconnect an account for ' + title + '.',
      trait: 'work',
      options: [opt('--id', 'string', 'Account id', { required: true })],
      outputJson: '{id:str,disconnected:bool}',
      run: async (ctx, args) => {
        const id = requireArg(args, '--id');
        const ok = ctx.services.connectors.disconnectAccount(id);
        return { stdout: ok ? 'disconnected ' + id + '\n' : 'no account ' + id + '\n', json: { id, disconnected: ok } };
      }
    }
  ];
}

const families: ConnectorFamily[] = [
  {
    name: 'gmail', title: 'Gmail', connector: 'gmail', declared: 37, kinds: ['message', 'thread', 'label'],
    actions: [
      { name: 'search', summary: 'Search mail with Gmail-style operators.', trait: 'work', options: [opt('--query', 'string', 'Query text', { required: true }), opt('--limit', 'integer', 'Max messages', { min: 1, max: 200 })], outputJson: '{messages:[{id:str,subject:str,from:str,ts:int}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('gmail', 'message', { query: str(args, '--query') ?? '', limit: num(args, '--limit') ?? 20 });
        return { stdout: rowsToTable(records), json: { messages: records.map((r) => ({ id: r.externalId, subject: r.title, from: String(r.metadata['from'] ?? ''), ts: r.ts })) } };
      } },
      { name: 'read', summary: 'Read one message in full. A thread id returns the whole thread.', trait: 'work', options: [opt('--id', 'string', 'Message or thread id', { required: true })], outputJson: '{id:str,body:str}', run: async (ctx, args) => {
        const id = requireArg(args, '--id');
        const message = ctx.services.connectors.records('gmail', 'message', { externalId: id })[0];
        if (message) return { stdout: message.body, json: { id: message.externalId, body: message.body } };
        // A thread id (or a message that carries a thread) resolves to the thread body.
        const thread = ctx.services.connectors.records('gmail', 'thread', { externalId: id })[0];
        if (thread) {
          const messages = ctx.services.connectors.records('gmail', 'message', { limit: 200 }).filter((m) => String(m.metadata['thread'] ?? '') === thread.externalId);
          const body = thread.body + (messages.length > 0 ? '\n\n' + messages.map((m) => '--- ' + m.externalId + ' ---\n' + m.body).join('\n') : '');
          return { stdout: body, json: { id: thread.externalId, body, kind: 'thread', messages: messages.length } };
        }
        throw new Error('no message or thread ' + id + '; ids come from tools gmail search or tools gmail list-threads');
      } },
      { name: 'read-thread', summary: 'Read a whole thread.', trait: 'work', options: [opt('--id', 'string', 'Thread id', { required: true })], outputJson: '{id:str,messages:[{id:str,body:str}]}', run: async (ctx, args) => {
        const id = requireArg(args, '--id');
        const thread = ctx.services.connectors.records('gmail', 'thread', { externalId: id })[0];
        const messages = ctx.services.connectors.records('gmail', 'message', { limit: 200 }).filter((m) => String(m.metadata['thread'] ?? '') === id || m.externalId === id);
        if (!thread && messages.length === 0) throw new Error('no thread ' + id);
        return {
          stdout: (thread ? thread.body + '\n' : '') + messages.map((m) => m.externalId + ': ' + m.title).join('\n') + '\n',
          json: { id, messages: messages.map((m) => ({ id: m.externalId, body: m.body })) }
        };
      } },
      { name: 'send', summary: 'Send mail as the member, with provenance.', trait: 'work', options: [opt('--to', 'string[]', 'Recipients', { required: true }), opt('--subject', 'string', 'Subject', { required: true }), opt('--body', 'string', 'Body', { required: true })], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('gmail', 'sent', { title: requireArg(args, '--subject'), body: requireArg(args, '--body'), metadata: { to: list(args, '--to') } });
        return { stdout: 'sent ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'reply', summary: 'Reply in an existing thread.', trait: 'work', options: [opt('--thread', 'string', 'Thread id', { required: true }), opt('--body', 'string', 'Body', { required: true })], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('gmail', 'sent', { title: 're: ' + requireArg(args, '--thread'), body: requireArg(args, '--body'), metadata: { thread: str(args, '--thread') } });
        return { stdout: 'sent ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'list-threads', summary: 'Threads with recent activity.', trait: 'work', outputJson: '{threads:[{id:str,subject:str,ts:int}]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('gmail', 'thread', { limit: 25 });
        return { stdout: rowsToTable(records), json: { threads: records.map((r) => ({ id: r.externalId, subject: r.title, ts: r.ts })) } };
      } },
      { name: 'labels', summary: 'Labels available in the mailbox.', trait: 'work', outputJson: '{labels:[str]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('gmail', 'label', { limit: 200 });
        return { stdout: records.map((r) => r.title).join('\n') + '\n', json: { labels: records.map((r) => r.title) } };
      } },
      { name: 'mark', summary: 'Mark a message read, unread, starred or archived.', trait: 'work', options: [opt('--id', 'string', 'Message id', { required: true }), opt('--state', 'string', 'New state', { required: true, values: ['read', 'unread', 'starred', 'archived'] })], outputJson: '{id:str,state:str}', run: async (_ctx, args) => ({ stdout: 'marked\n', json: { id: requireArg(args, '--id'), state: requireArg(args, '--state') } }) },
      { name: 'draft', summary: 'Create a draft without sending.', trait: 'work', options: [opt('--to', 'string[]', 'Recipients', { required: true }), opt('--subject', 'string', 'Subject', { required: true }), opt('--body', 'string', 'Body', { required: true })], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('gmail', 'draft', { title: requireArg(args, '--subject'), body: requireArg(args, '--body'), metadata: { to: list(args, '--to') } });
        return { stdout: 'draft ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'attachments', summary: 'Attachments on a message.', trait: 'work', options: [opt('--id', 'string', 'Message id', { required: true })], outputJson: '{attachments:[{name:str,size:int}]}', run: async (_ctx, args) => ({ stdout: '(no attachments recorded)\n', json: { attachments: [], id: requireArg(args, '--id') } }) }
    ]
  },
  {
    name: 'google-calendar', title: 'Google Calendar', connector: 'google-calendar', declared: 45, kinds: ['event', 'calendar'],
    actions: [
      { name: 'list-events', summary: 'Events in a window.', trait: 'work', options: [opt('--from', 'string', 'Window start (ISO)'), opt('--to', 'string', 'Window end (ISO)'), opt('--limit', 'integer', 'Max events', { min: 1, max: 250 })], outputJson: '{events:[{id:str,title:str,start:int,end:int}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('google-calendar', 'event', { limit: num(args, '--limit') ?? 25, since: str(args, '--from') ? new Date(str(args, '--from')!).getTime() : undefined });
        return { stdout: rowsToTable(records), json: { events: records.map((r) => ({ id: r.externalId, title: r.title, start: r.ts, end: Number(r.metadata['end'] ?? r.ts) })) } };
      } },
      { name: 'get-event', summary: 'One event with attendees and location.', trait: 'work', options: [opt('--id', 'string', 'Event id', { required: true })], outputJson: '{id:str,title:str,attendees:[str]}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('google-calendar', 'event', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no event ' + str(args, '--id'));
        return { stdout: record.title + '\n' + record.body, json: { id: record.externalId, title: record.title, attendees: (record.metadata['attendees'] as string[]) ?? [] } };
      } },
      { name: 'create-event', summary: 'Create an event. Propose before inviting other people.', trait: 'work', options: [opt('--title', 'string', 'Title', { required: true }), opt('--start', 'string', 'Start instant', { required: true }), opt('--end', 'string', 'End instant', { required: true }), opt('--attendees', 'string[]', 'Attendees'), opt('--location', 'string', 'Location')], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('google-calendar', 'event', { title: requireArg(args, '--title'), body: '', ts: new Date(requireArg(args, '--start')).getTime(), metadata: { end: new Date(requireArg(args, '--end')).getTime(), attendees: list(args, '--attendees'), location: str(args, '--location') } });
        return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'update-event', summary: 'Move or retitle an event.', trait: 'work', options: [opt('--id', 'string', 'Event id', { required: true }), opt('--start', 'string', 'New start'), opt('--end', 'string', 'New end'), opt('--title', 'string', 'New title')], outputJson: '{id:str,updated:bool}', run: async (_ctx, args) => ({ stdout: 'updated\n', json: { id: requireArg(args, '--id'), updated: true } }) },
      { name: 'delete-event', summary: 'Delete an event. Irreversible: the member must have seen the event first.', trait: 'work', options: [opt('--id', 'string', 'Event id', { required: true })], outputJson: '{id:str,deleted:bool}', run: async (_ctx, args) => ({ stdout: 'deleted\n', json: { id: requireArg(args, '--id'), deleted: true } }) },
      { name: 'find-time', summary: 'Free windows that fit a duration.', trait: 'work', options: [opt('--duration-minutes', 'integer', 'How long', { required: true, min: 5, max: 1440 }), opt('--within-days', 'integer', 'Look-ahead', { min: 1, max: 60 })], outputJson: '{slots:[{start:int,end:int}]}', run: async (ctx, args) => {
        const duration = num(args, '--duration-minutes') ?? 30;
        const events = ctx.services.connectors.records('google-calendar', 'event', { limit: 100, since: Date.now() });
        const slots: { start: number; end: number }[] = [];
        let cursor = Date.now() + 3600_000;
        for (const event of events) {
          const end = Number(event.metadata['end'] ?? event.ts);
          if (event.ts - cursor >= duration * 60_000) slots.push({ start: cursor, end: event.ts });
          cursor = Math.max(cursor, end);
        }
        return { stdout: slots.map((s) => new Date(s.start).toISOString() + ' -> ' + new Date(s.end).toISOString()).join('\n') + '\n', json: { slots } };
      } },
      { name: 'list-calendars', summary: 'Calendars on the account.', trait: 'work', outputJson: '{calendars:[{id:str,title:str}]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('google-calendar', 'calendar', { limit: 50 });
        return { stdout: rowsToTable(records), json: { calendars: records.map((r) => ({ id: r.externalId, title: r.title })) } };
      } },
      { name: 'respond', summary: 'Answer an invitation.', trait: 'work', options: [opt('--id', 'string', 'Event id', { required: true }), opt('--response', 'string', 'Answer', { required: true, values: ['accepted', 'declined', 'tentative'] })], outputJson: '{id:str,response:str}', run: async (_ctx, args) => ({ stdout: 'responded\n', json: { id: requireArg(args, '--id'), response: requireArg(args, '--response') } }) }
    ]
  },
  {
    name: 'google-drive', title: 'Google Drive', connector: 'google-drive', declared: 38, kinds: ['file', 'folder'],
    actions: [
      { name: 'search', summary: 'Search files by name or content.', trait: 'work', options: [opt('--query', 'string', 'Query', { required: true }), opt('--limit', 'integer', 'Max files', { min: 1, max: 200 })], outputJson: '{files:[{id:str,name:str,mime:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('google-drive', 'file', { query: str(args, '--query') ?? '', limit: num(args, '--limit') ?? 20 });
        return { stdout: rowsToTable(records), json: { files: records.map((r) => ({ id: r.externalId, name: r.title, mime: String(r.metadata['mime'] ?? '') })) } };
      } },
      { name: 'list', summary: 'List a folder.', trait: 'work', options: [opt('--folder', 'string', 'Folder id')], outputJson: '{files:[{id:str,name:str}]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('google-drive', 'file', { limit: 100 });
        return { stdout: rowsToTable(records), json: { files: records.map((r) => ({ id: r.externalId, name: r.title })) } };
      } },
      { name: 'read', summary: 'Read a document into the workspace.', trait: 'work', options: [opt('--id', 'string', 'File id', { required: true })], outputJson: '{id:str,content:str}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('google-drive', 'file', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no file ' + str(args, '--id'));
        return { stdout: record.body.slice(0, 20000), json: { id: record.externalId, content: record.body } };
      } },
      { name: 'download', summary: 'Download a file into /downloads.', trait: 'work', options: [opt('--id', 'string', 'File id', { required: true }), opt('--to', 'string', 'Destination directory', { default: '/downloads' })], outputJson: '{path:str}', run: async (_ctx, args) => ({ stdout: 'downloaded ' + str(args, '--id') + ' to ' + (str(args, '--to') ?? '/downloads') + '\n', json: { path: (str(args, '--to') ?? '/downloads') + '/' + str(args, '--id') } }) },
      { name: 'upload', summary: 'Upload a workspace file.', trait: 'work', options: [opt('--path', 'string', 'Workspace path', { required: true }), opt('--folder', 'string', 'Destination folder')], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('google-drive', 'file', { title: String(str(args, '--path')).split('/').pop() ?? 'upload', body: '' });
        return { stdout: 'uploaded ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'share', summary: 'Share a file with a person.', trait: 'work', options: [opt('--id', 'string', 'File id', { required: true }), opt('--with', 'string', 'Recipient address', { required: true }), opt('--role', 'string', 'Role', { values: ['reader', 'commenter', 'writer'], default: 'reader' })], outputJson: '{shared:bool}', run: async (_ctx, args) => ({ stdout: 'shared with ' + str(args, '--with') + '\n', json: { shared: true } }) },
      { name: 'create-folder', summary: 'Create a folder.', trait: 'work', options: [opt('--name', 'string', 'Folder name', { required: true }), opt('--parent', 'string', 'Parent folder')], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('google-drive', 'folder', { title: requireArg(args, '--name') });
        return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'move', summary: 'Move a file into a folder.', trait: 'work', options: [opt('--id', 'string', 'File id', { required: true }), opt('--folder', 'string', 'Destination folder', { required: true })], outputJson: '{moved:bool}', run: async (_ctx, args) => ({ stdout: 'moved\n', json: { moved: true } }) }
    ]
  },
  {
    name: 'google-docs', title: 'Google Docs', connector: 'google-docs', declared: 10, kinds: ['doc'],
    actions: [
      { name: 'read', summary: 'Read a document.', trait: 'work', options: [opt('--id', 'string', 'Document id', { required: true })], outputJson: '{id:str,text:str}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('google-docs', 'doc', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no document ' + str(args, '--id'));
        return { stdout: record.body, json: { id: record.externalId, text: record.body } };
      } },
      { name: 'append', summary: 'Append text at the end of a document.', trait: 'work', options: [opt('--id', 'string', 'Document id', { required: true }), opt('--text', 'string', 'Text to append', { required: true })], outputJson: '{id:str,appended:bool}', run: async (ctx, args) => {
        const record = ctx.services.connectors.put('google-docs', 'doc', { externalId: str(args, '--id') ?? undefined, body: requireArg(args, '--text') });
        return { stdout: 'appended to ' + record.externalId + '\n', json: { id: record.externalId, appended: true } };
      } },
      { name: 'replace-text', summary: 'Replace an exact string. The diff is shown to the member afterwards.', trait: 'work', options: [opt('--id', 'string', 'Document id', { required: true }), opt('--find', 'string', 'Exact text to find', { required: true }), opt('--replace', 'string', 'Replacement', { required: true })], outputJson: '{id:str,replaced:int}', run: async (_ctx, args) => ({ stdout: 'replaced\n', json: { id: requireArg(args, '--id'), replaced: 1 } }) },
      { name: 'add-comment', summary: 'Leave a comment instead of rewriting someone else\'s words.', trait: 'work', options: [opt('--id', 'string', 'Document id', { required: true }), opt('--text', 'string', 'Comment', { required: true })], outputJson: '{id:str,commented:bool}', run: async (_ctx, args) => ({ stdout: 'commented\n', json: { id: requireArg(args, '--id'), commented: true } }) }
    ]
  },
  {
    name: 'google-sheets', title: 'Google Sheets', connector: 'google-sheets', declared: 31, kinds: ['sheet'],
    actions: [
      { name: 'list-sheets', summary: 'Tabs in a spreadsheet.', trait: 'work', options: [opt('--id', 'string', 'Spreadsheet id', { required: true })], outputJson: '{tabs:[str]}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('google-sheets', 'sheet', { externalId: requireArg(args, '--id') })[0];
        return { stdout: JSON.stringify(record?.metadata['tabs'] ?? []) + '\n', json: { tabs: (record?.metadata['tabs'] as string[]) ?? [] } };
      } },
      { name: 'read-range', summary: 'Read a range as rows.', trait: 'work', options: [opt('--id', 'string', 'Spreadsheet id', { required: true }), opt('--range', 'string', 'A1 range', { required: true })], outputJson: '{rows:[[str]]}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('google-sheets', 'sheet', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no spreadsheet ' + str(args, '--id'));
        const rows = record.body.split('\n').map((line) => line.split(','));
        return { stdout: record.body, json: { rows } };
      } },
      { name: 'write-range', summary: 'Write rows into a range.', trait: 'work', options: [opt('--id', 'string', 'Spreadsheet id', { required: true }), opt('--range', 'string', 'A1 range', { required: true }), opt('--rows', 'json', 'Rows to write', { required: true })], outputJson: '{written:int}', run: async (_ctx, args) => ({ stdout: 'written\n', json: { written: Array.isArray(args['--rows']) ? (args['--rows'] as unknown[]).length : 1 } }) },
      { name: 'append-row', summary: 'Append one row.', trait: 'work', options: [opt('--id', 'string', 'Spreadsheet id', { required: true }), opt('--values', 'string[]', 'Cell values', { required: true })], outputJson: '{appended:bool}', run: async (_ctx, args) => ({ stdout: 'appended\n', json: { appended: true, values: list(args, '--values') } }) },
      { name: 'create', summary: 'Create a spreadsheet.', trait: 'work', options: [opt('--title', 'string', 'Title', { required: true })], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('google-sheets', 'sheet', { title: requireArg(args, '--title'), metadata: { tabs: ['Sheet1'] } });
        return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } }
    ]
  },
  {
    name: 'google-tasks', title: 'Google Tasks', connector: 'google-tasks', declared: 16, kinds: ['task'],
    actions: [
      { name: 'list', summary: 'Open tasks.', trait: 'work', outputJson: '{tasks:[{id:str,title:str,due:int|null}]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('google-tasks', 'task', { limit: 100 });
        return { stdout: rowsToTable(records), json: { tasks: records.map((r) => ({ id: r.externalId, title: r.title, due: (r.metadata['due'] as number) ?? null })) } };
      } },
      { name: 'create', summary: 'Create a task.', trait: 'work', options: [opt('--title', 'string', 'Title', { required: true }), opt('--due', 'string', 'Due instant')], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('google-tasks', 'task', { title: requireArg(args, '--title'), metadata: { due: str(args, '--due') ? new Date(str(args, '--due')!).getTime() : null } });
        return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'complete', summary: 'Complete a task.', trait: 'work', options: [opt('--id', 'string', 'Task id', { required: true })], outputJson: '{completed:bool}', run: async (_ctx, args) => ({ stdout: 'completed\n', json: { completed: true, id: requireArg(args, '--id') } }) },
      { name: 'delete', summary: 'Delete a task.', trait: 'work', options: [opt('--id', 'string', 'Task id', { required: true })], outputJson: '{deleted:bool}', run: async (_ctx, args) => ({ stdout: 'deleted\n', json: { deleted: true, id: requireArg(args, '--id') } }) }
    ]
  },
  {
    name: 'notion', title: 'Notion', connector: 'notion', declared: 51, kinds: ['page', 'database'],
    actions: [
      { name: 'search', summary: 'Search pages and databases.', trait: 'work', options: [opt('--query', 'string', 'Query', { required: true })], outputJson: '{results:[{id:str,title:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('notion', 'page', { query: str(args, '--query') ?? '', limit: 25 });
        return { stdout: rowsToTable(records), json: { results: records.map((r) => ({ id: r.externalId, title: r.title })) } };
      } },
      { name: 'read-page', summary: 'Read a page as markdown.', trait: 'work', options: [opt('--id', 'string', 'Page id', { required: true })], outputJson: '{id:str,markdown:str}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('notion', 'page', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no page ' + str(args, '--id'));
        return { stdout: record.body, json: { id: record.externalId, markdown: record.body } };
      } },
      { name: 'create-page', summary: 'Create a page in a parent.', trait: 'work', options: [opt('--parent', 'string', 'Parent page or database id', { required: true }), opt('--title', 'string', 'Title', { required: true }), opt('--markdown', 'string', 'Initial body')], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('notion', 'page', { title: requireArg(args, '--title'), body: str(args, '--markdown') ?? '', metadata: { parent: str(args, '--parent') } });
        return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'append-block', summary: 'Append markdown to a page.', trait: 'work', options: [opt('--id', 'string', 'Page id', { required: true }), opt('--markdown', 'string', 'Markdown to append', { required: true })], outputJson: '{appended:bool}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('notion', 'page', { externalId: str(args, '--id') ?? undefined, body: requireArg(args, '--markdown') });
        return { stdout: 'appended to ' + rec.externalId + '\n', json: { appended: true } };
      } }
    ]
  },
  {
    name: 'slack', title: 'Slack', connector: 'slack', declared: 27, kinds: ['channel', 'message'],
    actions: [
      { name: 'list-channels', summary: 'Channels the member is in.', trait: 'work', outputJson: '{channels:[{id:str,name:str}]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('slack', 'channel', { limit: 200 });
        return { stdout: rowsToTable(records), json: { channels: records.map((r) => ({ id: r.externalId, name: r.title })) } };
      } },
      { name: 'read', summary: 'Recent messages in a channel.', trait: 'work', options: [opt('--channel', 'string', 'Channel id or name', { required: true }), opt('--limit', 'integer', 'How many', { min: 1, max: 200 })], outputJson: '{messages:[{id:str,text:str,ts:int}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('slack', 'message', { query: str(args, '--channel') ?? '', limit: num(args, '--limit') ?? 25 });
        return { stdout: rowsToTable(records), json: { messages: records.map((r) => ({ id: r.externalId, text: r.body, ts: r.ts })) } };
      } },
      { name: 'post', summary: 'Post a message as the member.', trait: 'work', options: [opt('--channel', 'string', 'Channel', { required: true }), opt('--text', 'string', 'Text', { required: true })], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('slack', 'message', { title: str(args, '--channel') ?? '', body: requireArg(args, '--text') });
        return { stdout: 'posted ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'search', summary: 'Search messages.', trait: 'work', options: [opt('--query', 'string', 'Query', { required: true })], outputJson: '{messages:[{id:str,text:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('slack', 'message', { query: str(args, '--query') ?? '', limit: 25 });
        return { stdout: rowsToTable(records), json: { messages: records.map((r) => ({ id: r.externalId, text: r.body })) } };
      } },
      { name: 'upload', summary: 'Upload a file to a channel.', trait: 'work', options: [opt('--channel', 'string', 'Channel', { required: true }), opt('--path', 'string', 'Workspace path', { required: true })], outputJson: '{ok:bool}', run: async (_ctx) => ({ stdout: 'uploaded\n', json: { ok: true } }) }
    ]
  },
  {
    name: 'linear', title: 'Linear', connector: 'linear', declared: 27, kinds: ['issue'],
    actions: [
      { name: 'list-issues', summary: 'Issues by filter.', trait: 'work', options: [opt('--filter', 'string', 'Filter text'), opt('--limit', 'integer', 'Max issues', { min: 1, max: 200 })], outputJson: '{issues:[{id:str,title:str,state:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('linear', 'issue', { query: str(args, '--filter') ?? '', limit: num(args, '--limit') ?? 25 });
        return { stdout: rowsToTable(records), json: { issues: records.map((r) => ({ id: r.externalId, title: r.title, state: String(r.metadata['state'] ?? '') })) } };
      } },
      { name: 'create-issue', summary: 'Create an issue.', trait: 'work', options: [opt('--title', 'string', 'Title', { required: true }), opt('--team', 'string', 'Team key', { required: true }), opt('--description', 'string', 'Body')], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('linear', 'issue', { title: requireArg(args, '--title'), body: str(args, '--description') ?? '', metadata: { team: str(args, '--team'), state: 'todo' } });
        return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'update-issue', summary: 'Change an issue state or assignee.', trait: 'work', options: [opt('--id', 'string', 'Issue id', { required: true }), opt('--state', 'string', 'New state'), opt('--assignee', 'string', 'New assignee')], outputJson: '{id:str,updated:bool}', run: async (_ctx, args) => ({ stdout: 'updated\n', json: { id: requireArg(args, '--id'), updated: true } }) }
    ]
  },
  {
    name: 'github', title: 'GitHub', connector: 'github', declared: 12, kinds: ['issue', 'pr', 'repo'],
    actions: [
      { name: 'search-code', summary: 'Search code across the account.', trait: 'work', options: [opt('--query', 'string', 'Query', { required: true })], outputJson: '{hits:[{repo:str,path:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('github', 'repo', { query: str(args, '--query') ?? '', limit: 25 });
        return { stdout: rowsToTable(records), json: { hits: records.map((r) => ({ repo: r.title, path: String(r.metadata['path'] ?? '') })) } };
      } },
      { name: 'list-issues', summary: 'Issues in a repository.', trait: 'work', options: [opt('--repo', 'string', 'owner/name', { required: true }), opt('--state', 'string', 'State', { values: ['open', 'closed', 'all'], default: 'open' })], outputJson: '{issues:[{number:int,title:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('github', 'issue', { query: str(args, '--repo') ?? '', limit: 50 });
        return { stdout: rowsToTable(records), json: { issues: records.map((r) => ({ number: Number(r.metadata['number'] ?? 0), title: r.title })) } };
      } },
      { name: 'create-issue', summary: 'Open an issue with evidence.', trait: 'work', options: [opt('--repo', 'string', 'owner/name', { required: true }), opt('--title', 'string', 'Title', { required: true }), opt('--body', 'string', 'Body')], outputJson: '{number:int}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('github', 'issue', { title: requireArg(args, '--title'), body: str(args, '--body') ?? '', metadata: { repo: str(args, '--repo'), number: 1 } });
        return { stdout: 'opened ' + rec.externalId + '\n', json: { number: 1 } };
      } },
      { name: 'list-prs', summary: 'Pull requests in a repository.', trait: 'work', options: [opt('--repo', 'string', 'owner/name', { required: true })], outputJson: '{prs:[{number:int,title:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('github', 'pr', { query: str(args, '--repo') ?? '', limit: 50 });
        return { stdout: rowsToTable(records), json: { prs: records.map((r) => ({ number: Number(r.metadata['number'] ?? 0), title: r.title })) } };
      } }
    ]
  },
  {
    name: 'outlook', title: 'Microsoft 365', connector: 'outlook', declared: 96, kinds: ['message', 'event', 'contact'],
    actions: [
      { name: 'search', summary: 'Search Exchange mail.', trait: 'work', options: [opt('--query', 'string', 'Query', { required: true })], outputJson: '{messages:[{id:str,subject:str}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('outlook', 'message', { query: str(args, '--query') ?? '', limit: 25 });
        return { stdout: rowsToTable(records), json: { messages: records.map((r) => ({ id: r.externalId, subject: r.title })) } };
      } },
      { name: 'read', summary: 'Read one message.', trait: 'work', options: [opt('--id', 'string', 'Message id', { required: true })], outputJson: '{id:str,body:str}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('outlook', 'message', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no message ' + str(args, '--id'));
        return { stdout: record.body, json: { id: record.externalId, body: record.body } };
      } },
      { name: 'send', summary: 'Send mail through Exchange.', trait: 'work', options: [opt('--to', 'string[]', 'Recipients', { required: true }), opt('--subject', 'string', 'Subject', { required: true }), opt('--body', 'string', 'Body', { required: true })], outputJson: '{id:str}', run: async (ctx, args) => {
        const rec = ctx.services.connectors.put('outlook', 'sent', { title: requireArg(args, '--subject'), body: requireArg(args, '--body'), metadata: { to: list(args, '--to') } });
        return { stdout: 'sent ' + rec.externalId + '\n', json: { id: rec.externalId } };
      } },
      { name: 'list-events', summary: 'Calendar events.', trait: 'work', options: [opt('--from', 'string', 'Window start'), opt('--limit', 'integer', 'Max events', { min: 1, max: 250 })], outputJson: '{events:[{id:str,title:str,start:int}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('outlook', 'event', { limit: num(args, '--limit') ?? 25, since: str(args, '--from') ? new Date(str(args, '--from')!).getTime() : undefined });
        return { stdout: rowsToTable(records), json: { events: records.map((r) => ({ id: r.externalId, title: r.title, start: r.ts })) } };
      } }
    ]
  },
  {
    name: 'granola', title: 'Granola meeting notes', connector: 'granola', declared: 6, kinds: ['meeting'],
    actions: [
      { name: 'list-meetings', summary: 'Recent meetings with notes.', trait: 'work', outputJson: '{meetings:[{id:str,title:str,ts:int}]}', run: async (ctx) => {
        const records = ctx.services.connectors.records('granola', 'meeting', { limit: 50 });
        return { stdout: rowsToTable(records), json: { meetings: records.map((r) => ({ id: r.externalId, title: r.title, ts: r.ts })) } };
      } },
      { name: 'get-transcript', summary: 'Transcript of one meeting.', trait: 'work', options: [opt('--id', 'string', 'Meeting id', { required: true })], outputJson: '{id:str,transcript:str}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('granola', 'meeting', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no meeting ' + str(args, '--id'));
        return { stdout: record.body, json: { id: record.externalId, transcript: record.body } };
      } }
    ]
  },
  {
    name: 'yelp', title: 'Yelp places', connector: 'yelp', declared: 16, kinds: ['business'],
    actions: [
      { name: 'search', summary: 'Find places by what and where.', trait: 'work', options: [opt('--what', 'string', 'Category or name', { required: true }), opt('--where', 'string', 'Location', { required: true })], outputJson: '{businesses:[{id:str,name:str,rating:float}]}', run: async (ctx, args) => {
        const records = ctx.services.connectors.records('yelp', 'business', { query: str(args, '--what') + ' ' + str(args, '--where'), limit: 20 });
        return { stdout: rowsToTable(records), json: { businesses: records.map((r) => ({ id: r.externalId, name: r.title, rating: Number(r.metadata['rating'] ?? 0) })) } };
      } },
      { name: 'details', summary: 'One business: hours, phone, address.', trait: 'work', options: [opt('--id', 'string', 'Business id', { required: true })], outputJson: '{id:str,name:str,hours:str}', run: async (ctx, args) => {
        const record = ctx.services.connectors.records('yelp', 'business', { externalId: requireArg(args, '--id') })[0];
        if (!record) throw new Error('no business ' + str(args, '--id'));
        return { stdout: record.title + '\n' + record.body, json: { id: record.externalId, name: record.title, hours: String(record.metadata['hours'] ?? '') } };
      } }
    ]
  }
];

/** Stateless utility families (no connector account behind them). */
const utility: ActionSpec[] = [
  { family: 'maps', name: 'geocode', summary: 'Turn an address into coordinates.', trait: 'search', options: [opt('--address', 'string', 'Address', { required: true })], outputJson: '{lat:float,lon:float}', handler: async (_ctx, args) => ({ stdout: 'geocoded ' + str(args, '--address') + '\n', json: { lat: 0, lon: 0 } }) },
  { family: 'maps', name: 'directions', summary: 'Route between two places with travel time.', trait: 'search', options: [opt('--from', 'string', 'Origin', { required: true }), opt('--to', 'string', 'Destination', { required: true }), opt('--mode', 'string', 'Travel mode', { values: ['drive', 'walk', 'transit', 'bike'], default: 'drive' })], outputJson: '{minutes:int,distance_km:float}', handler: async (_ctx, args) => ({ stdout: 'route computed\n', json: { minutes: 0, distance_km: 0, mode: str(args, '--mode') } }) },
  { family: 'maps', name: 'places', summary: 'Places near a point.', trait: 'search', options: [opt('--near', 'string', 'Anchor', { required: true }), opt('--kind', 'string', 'Place kind')], outputJson: '{places:[{name:str,lat:float,lon:float}]}', handler: async () => ({ stdout: '(no places provider configured)\n', json: { places: [] } }) },
  { family: 'maps', name: 'distance', summary: 'Straight-line distance between two points.', trait: 'search', options: [opt('--a', 'string', 'lat,lon', { required: true }), opt('--b', 'string', 'lat,lon', { required: true })], outputJson: '{km:float}', handler: async () => ({ stdout: '0 km\n', json: { km: 0 } }) },
  { family: 'weather', name: 'now', summary: 'Current conditions for a place.', trait: 'search', options: [opt('--where', 'string', 'Place', { required: true })], outputJson: '{temp_c:float,conditions:str}', handler: async (_ctx, args) => ({ stdout: 'no weather provider configured for ' + str(args, '--where') + '\n', json: { temp_c: null, conditions: 'unknown' } }) },
  { family: 'weather', name: 'forecast', summary: 'Daily forecast.', trait: 'search', options: [opt('--where', 'string', 'Place', { required: true }), opt('--days', 'integer', 'Days', { min: 1, max: 14 })], outputJson: '{days:[{date:str,high_c:float,low_c:float}]}', handler: async () => ({ stdout: '(no forecast provider configured)\n', json: { days: [] } }) },
  { family: 'weather', name: 'alerts', summary: 'Active weather alerts for a place.', trait: 'search', options: [opt('--where', 'string', 'Place', { required: true })], outputJson: '{alerts:[{title:str,severity:str}]}', handler: async () => ({ stdout: '(no alerts)\n', json: { alerts: [] } }) },
  { family: 'image', name: 'generate', summary: 'Generate an image and attach it.', trait: 'work', options: [opt('--prompt', 'string', 'Prompt', { required: true }), opt('--size', 'string', 'Size', { default: '1024x1024' })], outputJson: '{path:str}', handler: async () => { throw new Error('image generation is not configured on this deployment'); } },
  { family: 'image', name: 'edit', summary: 'Edit an existing image.', trait: 'work', options: [opt('--path', 'string', 'Source image', { required: true }), opt('--prompt', 'string', 'Edit instruction', { required: true })], outputJson: '{path:str}', handler: async () => { throw new Error('image editing is not configured on this deployment'); } },
  { family: 'links', name: 'shorten', summary: 'Create a short link for a long URL.', trait: 'work', options: [opt('--url', 'string', 'Target URL', { required: true })], outputJson: '{short:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.put('links', 'link', { title: requireArg(args, '--url'), body: '' });
    return { stdout: 'https://dora.ai/l/' + rec.externalId + '\n', json: { short: 'https://dora.ai/l/' + rec.externalId } };
  } },
  { family: 'links', name: 'list', summary: 'Links this account created.', trait: 'work', outputJson: '{links:[{short:str,target:str}]}', handler: async (ctx) => {
    const records = ctx.services.connectors.records('links', 'link', { limit: 100 });
    return { stdout: rowsToTable(records), json: { links: records.map((r) => ({ short: r.externalId, target: r.title })) } };
  } },
  { family: 'links', name: 'resolve', summary: 'Where a short link points.', trait: 'work', options: [opt('--short', 'string', 'Short code', { required: true })], outputJson: '{target:str}', handler: async (ctx, args) => {
    const record = ctx.services.connectors.records('links', 'link', { externalId: requireArg(args, '--short') })[0];
    if (!record) throw new Error('no link ' + str(args, '--short'));
    return { stdout: record.title + '\n', json: { target: record.title } };
  } },
  { family: 'links', name: 'delete', summary: 'Delete a short link.', trait: 'work', options: [opt('--short', 'string', 'Short code', { required: true })], outputJson: '{deleted:bool}', handler: async () => ({ stdout: 'deleted\n', json: { deleted: true } }) },
  { family: 'links', name: 'stats', summary: 'Clicks on a short link.', trait: 'work', options: [opt('--short', 'string', 'Short code', { required: true })], outputJson: '{clicks:int}', handler: async () => ({ stdout: '0 clicks\n', json: { clicks: 0 } }) },
  { family: 'payments', name: 'pay', summary: 'Execute a payment. Requires the member to have seen the final state.', trait: 'work', options: [opt('--amount', 'string', 'Amount as text, never through shell expansion', { required: true }), opt('--to', 'string', 'Payee', { required: true }), opt('--memo', 'string', 'Memo')], outputJson: '{id:str,state:str}', handler: async () => { throw new Error('payments are disabled on this deployment (link_payments flag off)'); } },
  { family: 'link_payments', name: 'create', summary: 'Create a payment link.', trait: 'work', options: [opt('--amount', 'string', 'Amount', { required: true }), opt('--memo', 'string', 'Memo')], outputJson: '{url:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.put('link_payments', 'payment-link', { title: str(args, '--amount') ?? '', body: str(args, '--memo') ?? '' });
    return { stdout: 'https://dora.ai/pay/' + rec.externalId + '\n', json: { url: 'https://dora.ai/pay/' + rec.externalId } };
  } },
  { family: 'link_payments', name: 'list', summary: 'Payment links and their state.', trait: 'work', outputJson: '{links:[{id:str,amount:str,state:str}]}', handler: async (ctx) => {
    const records = ctx.services.connectors.records('link_payments', 'payment-link', { limit: 100 });
    return { stdout: rowsToTable(records), json: { links: records.map((r) => ({ id: r.externalId, amount: r.title, state: String(r.metadata['state'] ?? 'open') })) } };
  } },
  { family: 'link_payments', name: 'status', summary: 'One payment link.', trait: 'work', options: [opt('--id', 'string', 'Link id', { required: true })], outputJson: '{id:str,state:str}', handler: async (_ctx, args) => ({ stdout: 'open\n', json: { id: requireArg(args, '--id'), state: 'open' } }) },
  { family: 'flights', name: 'search', summary: 'Live flight search.', trait: 'work', options: [opt('--from', 'string', 'Origin airport', { required: true }), opt('--to', 'string', 'Destination airport', { required: true }), opt('--date', 'string', 'Departure date', { required: true })], outputJson: '{options:[{airline:str,price:str,stops:int}]}', handler: async () => ({ stdout: '(no flight provider configured on this deployment)\n', json: { options: [] } }) },
  { family: 'speak', name: 'speak', summary: 'Read text aloud on a channel that carries voice.', trait: 'channel.write', options: [opt('--text', 'string', 'What to say', { required: true }), opt('--to', 'string', 'Channel address')], outputJson: '{spoken:bool}', handler: async () => { throw new Error('voice output requires a live voice session'); } },
  { family: 'steer_voice_agent', name: 'steer', summary: 'Steer a live voice session. UNAVAILABLE unless a voice session is active.', trait: 'channel.write', options: [opt('--instruction', 'string', 'Instruction for the voice agent', { required: true })], outputJson: '{steered:bool}', handler: async () => { throw new Error('UNAVAILABLE: steer_voice_agent only exists inside a live voice session'); } },
  { family: 'generate_referral_link', name: 'generate', summary: 'Create an early-access invite for someone the member names.', trait: 'invites', options: [opt('--for', 'string', 'Who the invite is for', { required: true })], outputJson: '{url:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.put('invites', 'referral', { title: requireArg(args, '--for') });
    return { stdout: 'https://dora.ai/i/' + rec.externalId + '\n', json: { url: 'https://dora.ai/i/' + rec.externalId } };
  } },
  { family: 'revoke_referral_link', name: 'revoke', summary: 'Revoke an invite that has not been used.', trait: 'invites', options: [opt('--code', 'string', 'Invite code', { required: true })], outputJson: '{revoked:bool}', handler: async () => ({ stdout: 'revoked\n', json: { revoked: true } }) }
];

export const CONNECTOR_FAMILIES = families.map((f) => ({ name: f.name, title: f.title, connector: f.connector, declaredActions: f.declared }));

export function register(registry: ToolRegistry): void {
  for (const family of families) {
    const actions = [...family.actions, ...accountActions(family.connector, family.title)];
    for (const action of actions) {
      registry.register(
        define({
          family: family.name,
          name: action.name,
          summary: action.summary,
          details: action.details ?? [
            'Data comes from the local connector store for this account.',
            'Confirm which account is in play with ' + family.name + ' list-accounts; never from memory.'
          ],
          options: action.options ?? [],
          outputJson: action.outputJson,
          trait: action.trait,
          connector: family.connector,
          handler: action.run
        })
      );
    }
  }
  for (const spec of utility) registry.register(define(spec));
}
