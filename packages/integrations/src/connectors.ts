import { ulid, type ConnectorAccount, type ConnectorDescriptor, type ConnectorRecord, type ConnectorRegistry, type Db } from '@dora/core';

/**
 * Connector registry.
 *
 * A connector is a local account, not a vendor OAuth flow: a fixture dataset for
 * development, or a pasted access token / app password for real use. Names exist in the
 * catalogue regardless of connection state, and only a connected account yields a help
 * contract.
 */
export interface ConnectorSpec {
  name: string;
  title: string;
  declaredActions: number;
  implementedActions: number;
  authKind: ConnectorAccount['authKind'];
  description: string;
}

export const CONNECTOR_CATALOGUE: ConnectorSpec[] = [
  { name: 'gmail', title: 'Gmail', declaredActions: 37, implementedActions: 12, authKind: 'token', description: 'Mail search, read, send, drafts and labels.' },
  { name: 'google-calendar', title: 'Google Calendar', declaredActions: 45, implementedActions: 11, authKind: 'token', description: 'Events, invitations and free time.' },
  { name: 'google-drive', title: 'Google Drive', declaredActions: 38, implementedActions: 11, authKind: 'token', description: 'Files and folders.' },
  { name: 'google-docs', title: 'Google Docs', declaredActions: 10, implementedActions: 7, authKind: 'token', description: 'Documents.' },
  { name: 'google-sheets', title: 'Google Sheets', declaredActions: 31, implementedActions: 8, authKind: 'token', description: 'Spreadsheets.' },
  { name: 'google-slides', title: 'Google Slides', declaredActions: 16, implementedActions: 6, authKind: 'token', description: 'Decks.' },
  { name: 'google-tasks', title: 'Google Tasks', declaredActions: 16, implementedActions: 7, authKind: 'token', description: 'Task lists.' },
  { name: 'google-workspace', title: 'Google Workspace', declaredActions: 2, implementedActions: 2, authKind: 'none', description: 'Account set health.' },
  { name: 'notion', title: 'Notion', declaredActions: 51, implementedActions: 7, authKind: 'token', description: 'Pages and databases.' },
  { name: 'slack', title: 'Slack', declaredActions: 27, implementedActions: 8, authKind: 'token', description: 'Channels and messages as the member.' },
  { name: 'slackbot', title: 'Slack bot', declaredActions: 10, implementedActions: 6, authKind: 'token', description: 'Bot-authored messages.' },
  { name: 'github', title: 'GitHub', declaredActions: 12, implementedActions: 7, authKind: 'token', description: 'Repositories, issues, pull requests.' },
  { name: 'linear', title: 'Linear', declaredActions: 27, implementedActions: 6, authKind: 'token', description: 'Issues and projects.' },
  { name: 'outlook', title: 'Microsoft 365', declaredActions: 96, implementedActions: 7, authKind: 'token', description: 'Exchange mail and calendar.' },
  { name: 'granola', title: 'Granola', declaredActions: 6, implementedActions: 5, authKind: 'token', description: 'Meeting notes and transcripts.' },
  { name: 'yelp', title: 'Yelp', declaredActions: 16, implementedActions: 5, authKind: 'token', description: 'Local businesses.' },
  { name: 'agent-mail', title: 'Agent mailbox', declaredActions: 16, implementedActions: 11, authKind: 'none', description: 'The agent address at mail.dora.ai.' },
  { name: 'whatsapp', title: 'WhatsApp', declaredActions: 4, implementedActions: 4, authKind: 'password', description: 'Member conversation with the 24-hour window.' },
  { name: 'imessage', title: 'iMessage/SMS', declaredActions: 15, implementedActions: 11, authKind: 'none', description: 'Local bridge to the member line.' },
  { name: 'cloud_browser', title: 'Cloud browser', declaredActions: 27, implementedActions: 19, authKind: 'none', description: 'Rented browser and its lease scheduler.' },
  { name: 'link_payments', title: 'Payment links', declaredActions: 7, implementedActions: 3, authKind: 'token', description: 'Request payment.' },
  { name: 'payments', title: 'Payments', declaredActions: 1, implementedActions: 1, authKind: 'token', description: 'Execute payment.' },
  { name: 'links', title: 'Links', declaredActions: 5, implementedActions: 5, authKind: 'none', description: 'Short links.' },
  { name: 'maps', title: 'Maps', declaredActions: 4, implementedActions: 4, authKind: 'none', description: 'Geocoding and routes.' },
  { name: 'weather', title: 'Weather', declaredActions: 3, implementedActions: 3, authKind: 'none', description: 'Conditions and forecast.' },
  { name: 'image', title: 'Images', declaredActions: 2, implementedActions: 2, authKind: 'none', description: 'Image generation.' },
  { name: 'flights', title: 'Flights', declaredActions: 1, implementedActions: 1, authKind: 'none', description: 'Live flight search.' },
  { name: 'invites', title: 'Invites', declaredActions: 2, implementedActions: 2, authKind: 'none', description: 'Early-access referral links.' }
];

export class ConnectorStore implements ConnectorRegistry {
  private readonly db: Db;
  private readonly accountId: string;

  constructor(options: { db: Db; accountId: string }) {
    this.db = options.db;
    this.accountId = options.accountId;
  }

  list(): ConnectorDescriptor[] {
    return CONNECTOR_CATALOGUE.map((c) => ({
      name: c.name,
      title: c.title,
      declaredActions: c.declaredActions,
      implementedActions: c.implementedActions,
      authKind: c.authKind,
      description: c.description
    }));
  }

  accounts(connector?: string): ConnectorAccount[] {
    const rows = (connector
      ? this.db.prepare('SELECT * FROM connector_accounts WHERE connector = ? ORDER BY is_default DESC, created_at').all(connector)
      : this.db.prepare('SELECT * FROM connector_accounts ORDER BY connector, is_default DESC').all()) as {
      id: string;
      connector: string;
      label: string;
      is_default: number;
      created_at: number;
      auth_kind: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      connector: r.connector,
      label: r.label,
      isDefault: r.is_default === 1,
      createdAt: r.created_at,
      authKind: r.auth_kind as ConnectorAccount['authKind']
    }));
  }

  addAccount(connector: string, label: string, credentials: Record<string, string> = {}): ConnectorAccount {
    const spec = CONNECTOR_CATALOGUE.find((c) => c.name === connector);
    if (!spec) throw new Error('unknown connector: ' + connector);
    const existing = this.accounts(connector);
    const id = ulid('acct');
    const isDefault = existing.length === 0 ? 1 : 0;
    this.db
      .prepare('INSERT INTO connector_accounts (id, connector, label, is_default, auth_kind, created_at, credentials) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, connector, label, isDefault, spec.authKind, Date.now(), JSON.stringify(credentials));
    return { id, connector, label, isDefault: isDefault === 1, createdAt: Date.now(), authKind: spec.authKind };
  }

  disconnectAccount(id: string): boolean {
    const result = this.db.prepare('DELETE FROM connector_accounts WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  defaultAccount(connector: string): ConnectorAccount | null {
    return this.accounts(connector).find((a) => a.isDefault) ?? this.accounts(connector)[0] ?? null;
  }

  isConnected(connector: string): boolean {
    const spec = CONNECTOR_CATALOGUE.find((c) => c.name === connector);
    if (!spec) return false;
    if (spec.authKind === 'none') return true;
    return this.accounts(connector).length > 0;
  }

  records(
    connector: string,
    kind: string,
    options: { query?: string; limit?: number; accountId?: string; since?: number; externalId?: string } = {}
  ): ConnectorRecord[] {
    if (options.externalId) {
      const row = this.db
        .prepare('SELECT * FROM connector_records WHERE account_id = ? AND connector = ? AND kind = ? AND external_id = ?')
        .get(options.accountId ?? this.accountId, connector, kind, options.externalId) as
        | { id: string; account_id: string; connector: string; kind: string; external_id: string; title: string; body: string; ts: number; metadata: string }
        | undefined;
      return row
        ? [{
            id: row.id,
            connector: row.connector,
            accountId: row.account_id,
            kind: row.kind,
            externalId: row.external_id,
            title: row.title,
            body: row.body,
            ts: row.ts,
            metadata: JSON.parse(row.metadata) as Record<string, unknown>
          }]
        : [];
    }
    const limit = Math.min(options.limit ?? 50, 500);
    const since = options.since ?? 0;
    const rows = this.db
      .prepare('SELECT * FROM connector_records WHERE account_id = ? AND connector = ? AND kind = ? AND ts >= ? ORDER BY ts DESC LIMIT ?')
      .all(options.accountId ?? this.accountId, connector, kind, since, limit) as {
      id: string;
      account_id: string;
      connector: string;
      kind: string;
      external_id: string;
      title: string;
      body: string;
      ts: number;
      metadata: string;
    }[];
    const query = (options.query ?? '').toLowerCase().trim();
    const mapped = rows.map((r) => ({
      id: r.id,
      connector: r.connector,
      accountId: r.account_id,
      kind: r.kind,
      externalId: r.external_id,
      title: r.title,
      body: r.body,
      ts: r.ts,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>
    }));
    if (!query) return mapped;
    const terms = query.split(/\s+/).filter(Boolean);
    return mapped.filter((r) => {
      const hay = (r.title + ' ' + r.body + ' ' + JSON.stringify(r.metadata)).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  put(connector: string, kind: string, record: Partial<ConnectorRecord> & { title?: string }): ConnectorRecord {
    const externalId = record.externalId ?? ulid('ext').slice(-10);
    const id = this.accountId + ':' + connector + ':' + kind + ':' + externalId;
    const existing = this.db.prepare('SELECT body, title, metadata FROM connector_records WHERE id = ?').get(id) as
      | { body: string; title: string; metadata: string }
      | undefined;
    const body = record.body !== undefined ? record.body : (existing?.body ?? '');
    const metadata = { ...(existing ? (JSON.parse(existing.metadata) as Record<string, unknown>) : {}), ...(record.metadata ?? {}) };
    this.db
      .prepare(
        'INSERT INTO connector_records (id, account_id, connector, kind, external_id, title, body, ts, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(account_id, connector, kind, external_id) DO UPDATE SET title = excluded.title, body = excluded.body, ts = excluded.ts, metadata = excluded.metadata'
      )
      .run(id, this.accountId, connector, kind, externalId, record.title ?? existing?.title ?? '', body, record.ts ?? Date.now(), JSON.stringify(metadata));
    return {
      id,
      connector,
      accountId: this.accountId,
      kind,
      externalId,
      title: record.title ?? existing?.title ?? '',
      body,
      ts: record.ts ?? Date.now(),
      metadata
    };
  }
}
