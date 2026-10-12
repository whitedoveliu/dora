import { ulid, type AccountRef, type Channel, type ChannelMessage, type ChannelRegistry, type Db, type SessionRecord } from '@dora/core';

/**
 * Channels.
 *
 * IM is both input and output: the web console is a management surface, not the default
 * conversation entry point. WhatsApp carries the 24-hour customer-service window — once
 * it closes, only the four pre-approved templates may be sent.
 */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ChannelSpec {
  name: string;
  label: string;
  windowMs: number | null;
}

export const CHANNEL_SPECS: ChannelSpec[] = [
  { name: 'whatsapp', label: 'WhatsApp', windowMs: WHATSAPP_WINDOW_MS },
  { name: 'imessage', label: 'iMessage/SMS', windowMs: null },
  { name: 'agent-mail', label: 'Agent mailbox', windowMs: null },
  { name: 'console', label: 'Local console', windowMs: null }
];

export class ChannelStore implements ChannelRegistry {
  private readonly db: Db;
  private readonly accountId: string;
  private readonly account: AccountRef;
  private readonly echo: boolean;

  constructor(options: { db: Db; accountId: string; account: AccountRef; echo?: boolean }) {
    this.db = options.db;
    this.accountId = options.accountId;
    this.account = options.account;
    this.echo = options.echo ?? process.env.DORA_CHANNEL_ECHO === '1';
  }

  private make(spec: ChannelSpec): Channel {
    const db = this.db;
    const accountId = this.accountId;
    const echo = this.echo;
    const windowMs = spec.windowMs;

    const lastInbound = (address: string): number | null => {
      const row = db
        .prepare('SELECT last_inbound_at FROM channel_windows WHERE account_id = ? AND channel = ? AND address = ?')
        .get(accountId, spec.name, address) as { last_inbound_at: number } | undefined;
      return row ? row.last_inbound_at : null;
    };

    return {
      name: spec.name,
      windowOpen(address: string): boolean {
        if (windowMs === null) return true;
        const last = lastInbound(address);
        if (last === null) return false;
        return Date.now() - last < windowMs;
      },
      async send(input) {
        if (windowMs !== null && !input.template && !this.windowOpen(input.to)) {
          throw new Error(spec.label + ' window is closed for ' + input.to + '; only pre-approved templates may be sent');
        }
        const id = ulid('msg');
        const ts = Date.now();
        db.prepare(
          'INSERT INTO channel_messages (id, account_id, channel, direction, from_addr, to_addr, body, ts, thread_id, template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, accountId, spec.name, 'outbound', 'dora', input.to, input.body, ts, input.replyTo ?? null, input.template ?? null);
        if (echo) process.stdout.write('[' + spec.name + ' -> ' + input.to + '] ' + input.body + '\n');
        return { id, channel: spec.name, direction: 'outbound', from: 'dora', to: input.to, body: input.body, ts };
      },
      recordInbound(message): ChannelMessage {
        const id = ulid('msg');
        const ts = Date.now();
        db.prepare(
          'INSERT INTO channel_messages (id, account_id, channel, direction, from_addr, to_addr, body, ts, thread_id, template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, accountId, spec.name, 'inbound', message.from, message.to, message.body, ts, message.threadId ?? null, message.template ?? null);
        if (windowMs !== null) {
          db.prepare(
            'INSERT INTO channel_windows (account_id, channel, address, last_inbound_at) VALUES (?, ?, ?, ?) ' +
              'ON CONFLICT(account_id, channel, address) DO UPDATE SET last_inbound_at = excluded.last_inbound_at'
          ).run(accountId, spec.name, message.from, ts);
        }
        if (echo) process.stdout.write('[' + spec.name + ' <- ' + message.from + '] ' + message.body + '\n');
        return { id, channel: spec.name, direction: 'inbound', from: message.from, to: message.to, body: message.body, ts, threadId: message.threadId };
      },
      history(limit: number): ChannelMessage[] {
        const rows = db
          .prepare('SELECT * FROM channel_messages WHERE account_id = ? AND channel = ? ORDER BY ts DESC LIMIT ?')
          .all(accountId, spec.name, Math.min(limit, 500)) as {
          id: string; channel: string; direction: string; from_addr: string; to_addr: string; body: string; ts: number; thread_id: string | null; template: string | null;
        }[];
        return rows
          .map((r) => ({
            id: r.id,
            channel: r.channel,
            direction: r.direction as 'inbound' | 'outbound',
            from: r.from_addr,
            to: r.to_addr,
            body: r.body,
            ts: r.ts,
            threadId: r.thread_id ?? undefined,
            template: r.template ?? undefined
          }))
          .reverse();
      }
    };
  }

  list(): Channel[] {
    return CHANNEL_SPECS.map((spec) => this.make(spec));
  }

  get(name: string): Channel | null {
    const spec = CHANNEL_SPECS.find((s) => s.name === name);
    return spec ? this.make(spec) : null;
  }

  /** Deliver to the session's channel; the console channel is the local fallback. */
  async deliver(session: SessionRecord, body: string): Promise<{ channel: string; messageId: string; template?: string }> {
    const preferred = session.channel ?? 'console';
    const address = session.channel === 'whatsapp' ? this.account.phone : this.account.email || this.account.handle;
    const channel = this.get(preferred) ?? this.get('console')!;
    const sent = await channel.send({ to: address, body });
    return { channel: channel.name, messageId: sent.id };
  }
}
