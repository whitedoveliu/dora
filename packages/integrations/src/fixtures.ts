import type { ConnectorRegistry, ObservationsService } from '@dora/core';

/**
 * Local fixture accounts.
 *
 * This is how Dora.ai replaces the vendor login flow: every connector the agent can use
 * has a realistic local dataset, and a real account can be added at any time with
 * `tools <connector> add-account --label ... --token ...`. Nothing in the runtime knows
 * the difference, because the connector boundary is the same.
 */
export interface SeedOptions {
  connectors: ConnectorRegistry;
  observations: ObservationsService;
  account: { id: string; handle: string; displayName: string; email: string; phone: string };
  now?: () => number;
}

interface SeedRecord {
  connector: string;
  kind: string;
  externalId: string;
  title: string;
  body: string;
  offsetMs: number;
  metadata?: Record<string, unknown>;
  observationSource?: string;
}

export function fixtureRecords(now: number): SeedRecord[] {
  const hour = 3600_000;
  const day = 24 * hour;
  return [
    { connector: 'gmail', kind: 'message', externalId: 'gm_001', title: 'Q3 planning doc — please review before Thursday', body: 'Hi — can you read the planning doc and leave comments before Thursday standup? Nothing needs rewriting, just your read on the headcount section.', offsetMs: -2 * hour, metadata: { from: 'boss@acme.example', unread: true, thread: 'th_001' }, observationSource: 'gmail' },
    { connector: 'gmail', kind: 'message', externalId: 'gm_002', title: 'Your flight is confirmed — SFO to JFK', body: 'Confirmation ZQ8K2P. Departs SFO 07:40 on the 14th, arrives JFK 16:05. Baggage: one carry-on included.', offsetMs: -6 * hour, metadata: { from: 'no-reply@airline.example' }, observationSource: 'gmail' },
    { connector: 'gmail', kind: 'message', externalId: 'gm_003', title: 'Dinner reservation moved to 19:30', body: 'We moved your table to 19:30 for four people. Reply if you need the earlier slot back.', offsetMs: -1 * day, metadata: { from: 'host@restaurant.example' }, observationSource: 'gmail' },
    { connector: 'gmail', kind: 'message', externalId: 'gm_004', title: 'Statement ready', body: 'Your monthly statement is available in the portal.', offsetMs: -2 * day, metadata: { from: 'statements@bank.example' }, observationSource: 'gmail' },
    { connector: 'gmail', kind: 'message', externalId: 'gm_005', title: 'Package delivered to front desk', body: 'Delivered today at 14:12. Signed for by the building front desk.', offsetMs: -3 * day, metadata: { from: 'delivery@courier.example' }, observationSource: 'gmail' },
    {
      connector: 'gmail',
      kind: 'thread',
      externalId: 'th_001',
      title: 'Q3 planning doc',
      body: [
        '3 messages in this thread.',
        '',
        '1. boss@acme.example — Q3 planning doc — please review before Thursday',
        '   "can you read the planning doc and leave comments before Thursday standup? Nothing',
        '    needs rewriting, just your read on the headcount section."',
        '2. you — Re: Q3 planning doc — please review before Thursday',
        '   "will do, comments by Wednesday evening."',
        '3. boss@acme.example — Re: Q3 planning doc — please review before Thursday',
        '   "thanks — the headcount section is the one the board will push on."'
      ].join('\n'),
      offsetMs: -2 * hour
    },
    { connector: 'gmail', kind: 'label', externalId: 'lb_inbox', title: 'INBOX', body: '', offsetMs: -10 * day },
    { connector: 'gmail', kind: 'label', externalId: 'lb_travel', title: 'Travel', body: '', offsetMs: -10 * day },

    { connector: 'google-calendar', kind: 'event', externalId: 'ev_001', title: 'Standup', body: 'Daily standup', offsetMs: 5 * hour, metadata: { end: now + 5 * hour + 15 * 60_000, attendees: ['team@acme.example'] }, observationSource: 'calendar_events' },
    { connector: 'google-calendar', kind: 'event', externalId: 'ev_002', title: 'Dentist', body: 'Cleaning, 45 minutes', offsetMs: 2 * day, metadata: { end: now + 2 * day + 45 * 60_000, location: 'Market St' }, observationSource: 'calendar_events' },
    { connector: 'google-calendar', kind: 'event', externalId: 'ev_003', title: 'Flight SFO to JFK', body: 'Departure 07:40', offsetMs: 4 * day, metadata: { end: now + 4 * day + 6 * hour, location: 'SFO Terminal 2' }, observationSource: 'calendar_events' },
    { connector: 'google-calendar', kind: 'event', externalId: 'ev_004', title: 'Dinner with Alex', body: 'Table for four', offsetMs: 1 * day + 3 * hour, metadata: { end: now + 1 * day + 5 * hour }, observationSource: 'calendar_events' },
    { connector: 'google-calendar', kind: 'calendar', externalId: 'cal_primary', title: 'Primary', body: '', offsetMs: -20 * day },

    { connector: 'google-drive', kind: 'file', externalId: 'dr_001', title: 'Q3 planning', body: 'Headcount section: three hires, two backfills. The draft assumes no attrition.', offsetMs: -3 * hour, metadata: { mime: 'application/vnd.google-apps.document' }, observationSource: 'drive_files' },
    { connector: 'google-drive', kind: 'file', externalId: 'dr_002', title: 'Budget model 2026', body: 'Sheet with monthly burn and runway scenarios.', offsetMs: -2 * day, metadata: { mime: 'application/vnd.google-apps.spreadsheet' }, observationSource: 'drive_files' },
    { connector: 'google-drive', kind: 'folder', externalId: 'fd_001', title: 'Planning', body: '', offsetMs: -30 * day },

    { connector: 'google-docs', kind: 'doc', externalId: 'gd_001', title: 'Q3 planning', body: '# Q3 planning\n\n## Headcount\nThree hires.\n\n## Risks\nHiring pipeline is thin.', offsetMs: -3 * hour },
    { connector: 'google-sheets', kind: 'sheet', externalId: 'gs_001', title: 'Budget model 2026', body: 'month,burn,runway\nJan,180000,22\nFeb,182000,21', offsetMs: -2 * day, metadata: { tabs: ['Monthly', 'Scenarios'] } },
    { connector: 'google-tasks', kind: 'task', externalId: 'gt_001', title: 'Reply to the planning thread', body: '', offsetMs: -1 * hour, metadata: { due: now + day } },
    { connector: 'google-slides', kind: 'deck', externalId: 'gp_001', title: 'Quarterly review', body: '1. Results\n2. Headcount\n3. Ask', offsetMs: -5 * day },

    { connector: 'notion', kind: 'page', externalId: 'nt_001', title: 'Reading list', body: '- Two papers on memory architectures\n- One on retrieval evaluation', offsetMs: -4 * day },
    { connector: 'notion', kind: 'page', externalId: 'nt_002', title: 'Home projects', body: '- Fix the balcony door\n- Replace the kitchen filter', offsetMs: -9 * day },

    { connector: 'slack', kind: 'channel', externalId: 'sl_eng', title: 'eng', body: '', offsetMs: -40 * day },
    { connector: 'slack', kind: 'channel', externalId: 'sl_plan', title: 'planning', body: '', offsetMs: -40 * day },
    { connector: 'slack', kind: 'message', externalId: 'sl_m1', title: 'eng', body: 'deploy is green, rolling out to 10%', offsetMs: -90 * 60_000 },
    { connector: 'slack', kind: 'message', externalId: 'sl_m2', title: 'planning', body: '@you can you take the headcount section?', offsetMs: -3 * hour },

    { connector: 'github', kind: 'issue', externalId: 'gh_101', title: 'Flaky test in retry path', body: 'The retry test fails roughly one run in twenty.', offsetMs: -6 * hour, metadata: { repo: 'acme/agent', number: 101 } },
    { connector: 'github', kind: 'issue', externalId: 'gh_102', title: 'Document the vault fill flow', body: 'The fill-only path has no docs.', offsetMs: -2 * day, metadata: { repo: 'acme/agent', number: 102 } },
    { connector: 'github', kind: 'pr', externalId: 'gh_pr7', title: 'Add lease contention handling', body: 'Coordinates the shared write lease.', offsetMs: -1 * day, metadata: { repo: 'acme/agent', number: 7 } },
    { connector: 'github', kind: 'repo', externalId: 'gh_repo', title: 'acme/agent', body: '', offsetMs: -400 * day, metadata: { path: 'src/lease.ts' } },

    { connector: 'linear', kind: 'issue', externalId: 'ln_1', title: 'Wake scheduler drift', body: 'Cadence wakes drift by up to a minute.', offsetMs: -8 * hour, metadata: { state: 'todo', team: 'ENG' } },
    { connector: 'linear', kind: 'issue', externalId: 'ln_2', title: 'Observation index row cap', body: 'Hitting the 10k cap on long queries.', offsetMs: -3 * day, metadata: { state: 'in_progress', team: 'ENG' } },

    { connector: 'outlook', kind: 'message', externalId: 'ol_1', title: 'Contract redlines', body: 'Legal sent back two comments on section 4.', offsetMs: -4 * hour, metadata: { from: 'legal@corp.example' } },
    { connector: 'outlook', kind: 'event', externalId: 'ol_ev1', title: 'Board sync', body: '', offsetMs: 3 * day, metadata: { end: now + 3 * day + hour } },

    { connector: 'granola', kind: 'meeting', externalId: 'gr_1', title: 'Weekly with Alex', body: 'Alex: wants the pilot scoped by Friday. Owner: you. Risk: legal review is the long pole.', offsetMs: -1 * day },
    { connector: 'granola', kind: 'meeting', externalId: 'gr_2', title: 'Vendor call', body: 'Pricing is 12k/year, they will not move below 10k. Trial extension is possible.', offsetMs: -4 * day },

    { connector: 'yelp', kind: 'business', externalId: 'yp_1', title: 'Nopa', body: 'New American, open until 23:00.', offsetMs: -20 * day, metadata: { rating: 4.4, hours: '17:30-23:00' } },
    { connector: 'yelp', kind: 'business', externalId: 'yp_2', title: 'Tartine', body: 'Bakery, open until 17:00.', offsetMs: -20 * day, metadata: { rating: 4.5, hours: '07:30-17:00' } },
    { connector: 'yelp', kind: 'business', externalId: 'yp_3', title: 'Zuni Cafe', body: 'Californian, open until 22:00.', offsetMs: -20 * day, metadata: { rating: 4.3, hours: '11:00-22:00' } },

    { connector: 'link_payments', kind: 'payment-link', externalId: 'lp_1', title: '85.00', body: 'Split for dinner', offsetMs: -10 * day, metadata: { state: 'paid' } },

    // A reachable conversation partner, so "reply to Alex" is resolvable rather than guesswork.
    { connector: 'imessage', kind: 'thread', externalId: '+14155550123', title: 'Alex Chen', body: 'Alex Chen <+14155550123>', offsetMs: -3 * hour, metadata: { handle: '+14155550123', person: 'alex' } },
    { connector: 'imessage', kind: 'message', externalId: 'im_001', title: 'Alex Chen', body: '周五的晚餐能改到 20:00 吗？', offsetMs: -3 * hour, metadata: { handle: '+14155550123', direction: 'inbound', thread: '+14155550123' }, observationSource: 'phone_messages' },
    { connector: 'imessage', kind: 'message', externalId: 'im_002', title: 'Alex Chen', body: '可以，我订 20:00 的位子。', offsetMs: -150 * 60_000, metadata: { handle: '+14155550123', direction: 'outbound', thread: '+14155550123' }, observationSource: 'phone_messages' },
    { connector: 'imessage', kind: 'message', externalId: 'im_003', title: 'Alex Chen', body: 'planning 文档你看了吗？', offsetMs: -40 * 60_000, metadata: { handle: '+14155550123', direction: 'inbound', thread: '+14155550123' }, observationSource: 'phone_messages' }
  ];
}

export function seedFixtures(options: SeedOptions): { accounts: number; records: number; observations: number } {
  const { connectors, observations, account } = options;
  const now = (options.now ?? Date.now)();
  const wanted = new Set([
    'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets', 'google-tasks',
    'google-slides', 'google-workspace', 'notion', 'slack', 'slackbot', 'github', 'linear',
    'outlook', 'granola', 'yelp', 'agent-mail', 'whatsapp', 'imessage'
  ]);

  let accounts = 0;
  for (const spec of connectors.list()) {
    if (!wanted.has(spec.name)) continue;
    if (connectors.accounts(spec.name).length > 0) continue;
    const label =
      spec.name === 'agent-mail' ? account.handle + '@mail.dora.ai'
      : spec.name === 'whatsapp' || spec.name === 'imessage' ? account.phone
      : account.email;
    connectors.addAccount(spec.name, label, { fixture: 'true' });
    accounts += 1;
  }

  let records = 0;
  const observationBatch: Record<string, Record<string, unknown>[]> = {};
  for (const record of fixtureRecords(now)) {
    const existing = connectors.records(record.connector, record.kind, { limit: 500 }).find((r) => r.externalId === record.externalId);
    if (existing) continue;
    // ts is relative to now, and put() takes an absolute timestamp.
    connectors.put(record.connector, record.kind, {
      externalId: record.externalId,
      title: record.title,
      body: record.body,
      ts: now + record.offsetMs,
      metadata: record.metadata ?? {}
    });
    records += 1;
    if (record.observationSource) {
      const list = observationBatch[record.observationSource] ?? [];
      list.push({
        path: record.observationSource + '/' + record.externalId,
        title: record.title,
        body: record.body,
        ts: now + record.offsetMs,
        mime: 'text/plain',
        metadata: record.metadata ?? {}
      });
      observationBatch[record.observationSource] = list;
    }
  }

  let observationCount = 0;
  for (const [source, rows] of Object.entries(observationBatch)) {
    observationCount += observations.ingest(source, rows);
  }
  return { accounts, records, observations: observationCount };
}
