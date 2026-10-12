import { ulid, type Attachment, type BrowserLease, type BrowserService, type Db } from '@dora/core';

/**
 * Rented browser.
 *
 * The guidance token is a hard data-flow constraint rather than advice:
 * browser_guidance.search returns a guidance_token, and acquire refuses a site whose
 * field notes exist unless that token comes back.
 *
 * The driver itself is pluggable. The local driver speaks HTTP and keeps a small page
 * model per lease (title, text, links, form fields), which is enough for read-shaped
 * flows — look something up, verify a price, check a booking page — without a vendor
 * browser subscription. Screenshots in this build return a text rendering of the page.
 */
export interface BrowserStoreOptions {
  db: Db;
  accountId: string;
  /** Refuse acquire on a site that has guidance unless a token is presented. */
  enforceGuidance?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface PageForm {
  ref: string;
  action: string;
  method: string;
  /** Refs of the fields this form owns, in document order. */
  fields: string[];
  /** Ref of the element that submits it. */
  submitRef: string | null;
}

interface PageState {
  url: string;
  status?: number;
  title: string;
  text: string;
  links: { ref: string; href: string; text: string }[];
  fields: { ref: string; name: string; type: string; form: string | null }[];
  forms: PageForm[];
  typed: Record<string, string>;
}

export class LocalBrowserService implements BrowserService {
  private readonly db: Db;
  private readonly accountId: string;
  private readonly enforceGuidance: boolean;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly pages = new Map<string, PageState>();

  constructor(options: BrowserStoreOptions) {
    this.db = options.db;
    this.accountId = options.accountId;
    this.enforceGuidance = options.enforceGuidance ?? false;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private row(leaseId: string): { id: string; session_id: string; kind: string; site: string | null; created_at: number; expires_at: number; released_at: number | null } | undefined {
    return this.db.prepare('SELECT * FROM browser_leases WHERE id = ?').get(leaseId) as
      | { id: string; session_id: string; kind: string; site: string | null; created_at: number; expires_at: number; released_at: number | null }
      | undefined;
  }

  private toLease(row: { id: string; session_id: string; kind: string; site: string | null; created_at: number; expires_at: number }): BrowserLease {
    return { id: row.id, sessionId: row.session_id, kind: row.kind as 'read' | 'write', createdAt: row.created_at, expiresAt: row.expires_at, site: row.site };
  }

  acquire(input: { sessionId: string; kind: 'read' | 'write'; site?: string; guidanceToken?: string; ttlMinutes?: number }): BrowserLease {
    const site = input.site ?? null;
    if (input.kind === 'write') {
      const holder = this.leases().find((l) => l.kind === 'write' && l.expiresAt > this.now());
      if (holder && holder.sessionId !== input.sessionId) {
        const err = new Error('write lease is held by session ' + holder.sessionId + '; the coordinator frees, reprioritises, or makes one wait');
        (err as { code?: string }).code = 'lease_conflict';
        throw err;
      }
    }
    if (this.enforceGuidance && site) {
      const notes = this.db.prepare('SELECT COUNT(*) AS n FROM browser_guidance WHERE account_id = ? AND site = ?').get(this.accountId, site) as { n: number };
      if (Number(notes.n) > 0 && !input.guidanceToken) {
        throw new Error('guidance exists for ' + site + '; call browser_guidance.search first and pass --guidance-token');
      }
      if (input.guidanceToken && !this.tokenValid(input.guidanceToken)) {
        throw new Error('guidance token is not valid for this account');
      }
    }
    const id = ulid('lease');
    const createdAt = this.now();
    const expiresAt = createdAt + (input.ttlMinutes ?? 15) * 60_000;
    this.db
      .prepare('INSERT INTO browser_leases (id, session_id, account_id, kind, site, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.sessionId, this.accountId, input.kind, site, createdAt, expiresAt);
    return { id, sessionId: input.sessionId, kind: input.kind, createdAt, expiresAt, site };
  }

  private tokenValid(token: string): boolean {
    return token.startsWith('guide_') && token.endsWith(this.accountId.slice(-6));
  }

  release(leaseId: string): boolean;
  release(leaseId: string, sessionId: string): boolean;
  release(leaseId: string, _sessionId?: string): boolean {
    const result = this.db.prepare('UPDATE browser_leases SET released_at = ? WHERE id = ? AND released_at IS NULL').run(this.now(), leaseId);
    this.pages.delete(leaseId);
    return Number(result.changes) > 0;
  }

  extend(leaseId: string, _sessionId: string, minutes: number): BrowserLease {
    const row = this.row(leaseId);
    if (!row) throw new Error('no lease ' + leaseId);
    const expiresAt = Math.max(row.expires_at, this.now()) + minutes * 60_000;
    this.db.prepare('UPDATE browser_leases SET expires_at = ? WHERE id = ?').run(expiresAt, leaseId);
    return this.toLease({ ...row, expires_at: expiresAt });
  }

  status(leaseId: string): BrowserLease | null {
    const row = this.row(leaseId);
    if (!row || row.released_at !== null) return null;
    return this.toLease(row);
  }

  leases(): BrowserLease[] {
    const rows = this.db
      .prepare('SELECT * FROM browser_leases WHERE account_id = ? AND released_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
      .all(this.accountId, this.now()) as { id: string; session_id: string; kind: string; site: string | null; created_at: number; expires_at: number }[];
    return rows.map((r) => this.toLease(r));
  }

  private requireLease(leaseId: string): void {
    const lease = this.status(leaseId);
    if (!lease) throw new Error('no active session: the lease is missing, released or expired — acquire again');
  }

  async drive(leaseId: string, command: Record<string, unknown>): Promise<{ ok: boolean; stdout: string; attachment?: Attachment }> {
    this.requireLease(leaseId);
    const op = String(command['op'] ?? '');
    const page = this.pages.get(leaseId) ?? null;

    switch (op) {
      case 'open': {
        const url = String(command['url']);
        const next = await this.load(url);
        this.pages.set(leaseId, next);
        return { ok: true, stdout: 'opened ' + next.url + ' — ' + next.title + '\n' + next.text.slice(0, 800) };
      }
      case 'snapshot': {
        if (!page) throw new Error('no page is open in this lease');
        const lines = [
          'url: ' + page.url,
          'title: ' + page.title,
          'links:',
          ...page.links.slice(0, 40).map((l) => '  ' + l.ref + '  ' + l.text.slice(0, 60) + '  -> ' + l.href),
          'fields:',
          ...page.fields.slice(0, 40).map((f) => '  ' + f.ref + '  ' + f.type + '  ' + f.name + (f.form ? '  (' + f.form + ')' : '')),
          'forms:',
          ...page.forms.slice(0, 10).map((f) => '  ' + f.ref + '  ' + f.method + ' ' + f.action + '  submit=' + (f.submitRef ?? 'none'))
        ];
        return { ok: true, stdout: lines.join('\n') + '\n' };
      }
      case 'read': {
        if (!page) throw new Error('no page is open in this lease');
        return { ok: true, stdout: page.text.slice(0, 20000) };
      }
      case 'current-url': {
        if (!page) throw new Error('no page is open in this lease');
        return { ok: true, stdout: page.url + '\n' + page.title + '\n' };
      }
      case 'type': {
        if (!page) throw new Error('no page is open in this lease');
        const ref = String(command['ref']);
        page.typed[ref] = String(command['text'] ?? '');
        return { ok: true, stdout: 'typed into ' + ref + ' (' + page.typed[ref].length + ' chars)\n' };
      }
      case 'click': {
        if (!page) throw new Error('no page is open in this lease');
        const ref = String(command['ref']);
        const link = page.links.find((l) => l.ref === ref);
        if (link) {
          const next = await this.load(link.href);
          this.pages.set(leaseId, next);
          return { ok: true, stdout: 'navigated to ' + next.url + ' — ' + next.title + '\n' };
        }
        const field = page.fields.find((f) => f.ref === ref);
        if (field) {
          // Submitting means submitting the form that owns the control: use its action and
          // its method, and send every field of that form that has a value.
          const form = page.forms.find((f) => f.ref === field.form) ?? page.forms[0] ?? null;
          const formFields = form ? page.fields.filter((f) => form.fields.includes(f.ref)) : page.fields;
          const pairs: [string, string][] = [];
          for (const f of formFields) {
            const value = page.typed[f.ref];
            if (value !== undefined && value !== '') pairs.push([f.name, value]);
          }
          const target = form ? form.action : page.url.split('?')[0];
          const method = form ? form.method : 'GET';
          let next: PageState;
          if (method === 'POST') {
            const body = new URLSearchParams(pairs).toString();
            const response = await this.fetchImpl(target, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'DoraBrowser/1.0 (+https://dora.ai)' },
              body
            });
            next = await this.parse(response, target);
          } else {
            const query = new URLSearchParams(pairs).toString();
            const url = target + (target.includes('?') ? '&' : '?') + query;
            const response = await this.fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'DoraBrowser/1.0 (+https://dora.ai)' } });
            next = await this.parse(response, url);
          }
          this.pages.set(leaseId, next);
          const status = next.status ?? 200;
          return {
            ok: status < 400,
            stdout:
              (status < 400 ? 'submitted' : 'the site refused the submission (HTTP ' + status + ')') +
              ' to ' + next.url + ' — ' + next.title + '\n' + next.text.slice(0, 600) + '\n'
          };
        }
        return { ok: false, stdout: 'ref ' + ref + ' is not in the current snapshot; take a new snapshot\n' };
      }
      case 'screenshot': {
        if (!page) throw new Error('no page is open in this lease');
        const rendering = 'TEXT RENDER of ' + page.url + '\n\n' + page.title + '\n\n' + page.text.slice(0, 4000);
        return {
          ok: true,
          stdout: 'screenshot captured (text rendering in this build): ' + page.url + '\n',
          attachment: { name: 'screenshot.txt', kind: 'media', mime: 'text/plain', content: rendering, truncated: false }
        };
      }
      case 'wait':
        return { ok: true, stdout: 'page is ' + (page ? 'ready' : 'empty') + '\n' };
      case 'scroll':
        return { ok: true, stdout: 'scrolled ' + String(command['direction'] ?? 'down') + '\n' };
      case 'list':
        return { ok: true, stdout: (page ? page.url : '(no page)') + '\n' };
      case 'close':
        this.pages.delete(leaseId);
        return { ok: true, stdout: 'closed\n' };
      default:
        throw new Error('unsupported browser operation: ' + op);
    }
  }

  private async load(url: string): Promise<PageState> {
    const absolute = url.startsWith('http') ? url : 'https://' + url.replace(/^\/+/, '');
    const response = await this.fetchImpl(absolute, { redirect: 'follow', headers: { 'user-agent': 'DoraBrowser/1.0 (+https://dora.ai)' } });
    return this.parse(response, absolute);
  }

  /** Turn a fetched response into page state: text, links, controls and their forms. */
  private async parse(response: Response, requestedUrl: string): Promise<PageState> {
    const html = await response.text();
    const finalUrl = response.url || requestedUrl;
    const status = response.status;
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const links: PageState['links'] = [];
    let refIndex = 0;
    for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = new URL(m[1], finalUrl).toString();
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      refIndex += 1;
      links.push({ ref: 'a' + refIndex, href, text: label });
      if (links.length >= 200) break;
    }
    const fields: PageState['fields'] = [];
    const forms: PageForm[] = [];
    let fieldIndex = 0;
    let formIndex = 0;

    // Walk controls in document order so each one is attributed to the form that owns it.
    const controlRe = /<form\s([^>]*)>|<\/form>|<(input|textarea|select|button)\s([^>]*)>/gi;
    let currentForm: PageForm | null = null;
    for (const m of html.matchAll(controlRe)) {
      const raw = m[0];
      if (raw.slice(0, 5).toLowerCase() === '<form') {
        const attrs = m[1] ?? '';
        formIndex += 1;
        const actionRaw = /action=["']([^"']*)["']/.exec(attrs)?.[1] || finalUrl;
        currentForm = {
          ref: 'form' + formIndex,
          action: new URL(actionRaw, finalUrl).toString(),
          method: (/method=["']([^"']+)["']/i.exec(attrs)?.[1] ?? 'get').toUpperCase(),
          fields: [],
          submitRef: null
        };
        forms.push(currentForm);
        continue;
      }
      if (raw.slice(0, 6).toLowerCase() === '</form') {
        currentForm = null;
        continue;
      }
      const tag = (m[2] ?? '').toLowerCase();
      const attrs = m[3] ?? '';
      const typeAttr = /type=["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
      const isSubmit = tag === 'button' || (tag === 'input' && /^(submit|button|image)$/i.test(typeAttr));
      const name = /name=["']([^"']+)["']/.exec(attrs)?.[1] ?? /id=["']([^"']+)["']/.exec(attrs)?.[1] ?? (isSubmit ? 'submit' : 'field');
      fieldIndex += 1;
      const ref = 'f' + fieldIndex;
      fields.push({ ref, name, type: isSubmit ? 'submit' : tag === 'input' ? typeAttr || 'text' : tag, form: currentForm ? currentForm.ref : null });
      if (currentForm) {
        currentForm.fields.push(ref);
        if (isSubmit && !currentForm.submitRef) currentForm.submitRef = ref;
      }
      if (fields.length >= 200) break;
    }
    for (const form of forms) {
      if (!form.submitRef && form.fields.length > 0) form.submitRef = form.fields[form.fields.length - 1];
    }
    return { url: finalUrl, status, title, text, links, fields, forms, typed: {} };
  }

  readonly guidance = {
    search: (input: { site: string; flow?: string }) => {
      const rows = this.db
        .prepare('SELECT * FROM browser_guidance WHERE account_id = ? AND site = ? ORDER BY created_at DESC LIMIT 25')
        .all(this.accountId, input.site) as { id: string; site: string; flow: string; outcome: string; notes: string }[];
      const filtered = input.flow ? rows.filter((r) => r.flow === input.flow) : rows;
      if (filtered.length === 0) return null;
      const token = 'guide_' + Buffer.from(input.site + ':' + Date.now()).toString('base64url').slice(0, 16) + this.accountId.slice(-6);
      return {
        token,
        entries: filtered.map((r) => ({ id: r.id, site: r.site, flow: r.flow, outcome: r.outcome, notes: r.notes }))
      };
    },
    record: (input: { site: string; flow: string; outcome: 'success' | 'failure'; notes: string }) => {
      const id = ulid('guide');
      this.db
        .prepare('INSERT INTO browser_guidance (id, account_id, site, flow, outcome, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, this.accountId, input.site, input.flow, input.outcome, input.notes, this.now());
      return { id };
    },
    list: () => {
      const rows = this.db
        .prepare('SELECT * FROM browser_guidance WHERE account_id = ? ORDER BY created_at DESC LIMIT 200')
        .all(this.accountId) as { id: string; site: string; flow: string; outcome: string; notes: string }[];
      return rows.map((r) => ({ id: r.id, site: r.site, flow: r.flow, outcome: r.outcome, notes: r.notes }));
    }
  };
}
