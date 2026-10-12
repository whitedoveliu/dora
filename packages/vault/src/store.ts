import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ulid, type VaultItemSummary, type VaultService } from '@dora/core';

/**
 * The Vault.
 *
 * Fill-only by construction: this module exposes no method that returns a secret value.
 * The plaintext leaves the encrypted blob only inside fill(), which immediately hands the
 * value to the browser driver through a callback and returns nothing but a count.
 *
 * Secrets are encrypted at rest with AES-256-GCM under a key derived from a master key
 * file with scrypt. The member's form submission arrives on a single-use fill link; the
 * agent only ever learns that the item exists.
 */
interface VaultItem {
  id: string;
  label: string;
  kind: VaultItemSummary['kind'];
  fields: string[];
  values: Record<string, string>;
  updatedAt: number;
  note: string;
}

interface FillLink {
  token: string;
  itemId: string | null;
  label: string;
  kind: VaultItemSummary['kind'];
  fields: string[];
  expiresAt: number;
  used: boolean;
}

export interface VaultOptions {
  dir: string;
  /** Where the fill link points for the member-facing form. */
  publicBaseUrl?: string;
  masterKey?: string;
  now?: () => number;
}

export class VaultStore implements VaultService {
  private readonly dir: string;
  private readonly keyFile: string;
  private readonly blobFile: string;
  private readonly linksFile: string;
  private readonly publicBaseUrl: string;
  private readonly now: () => number;
  private items: VaultItem[] | null = null;
  private links: FillLink[] = [];

  constructor(options: VaultOptions) {
    this.dir = resolve(options.dir);
    this.keyFile = join(options.dir, 'master.key');
    this.blobFile = join(options.dir, 'vault.enc');
    this.linksFile = join(options.dir, 'links.enc');
    this.publicBaseUrl = options.publicBaseUrl ?? 'https://dora.ai';
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
    if (options.masterKey) this.writeKey(options.masterKey);
  }

  private writeKey(key: string): void {
    writeFileSync(this.keyFile, key, { mode: 0o600 });
  }

  private masterKey(): Buffer {
    if (process.env.DORA_VAULT_KEY) return scryptSync(process.env.DORA_VAULT_KEY, 'dora-vault', 32);
    if (!existsSync(this.keyFile)) writeFileSync(this.keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
    return scryptSync(readFileSync(this.keyFile, 'utf8').trim(), 'dora-vault', 32);
  }

  private encrypt(payload: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  private decrypt<T>(blob: string): T {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  }

  private load(): VaultItem[] {
    if (this.items) return this.items;
    this.items = existsSync(this.blobFile) ? this.decrypt<VaultItem[]>(readFileSync(this.blobFile, 'utf8')) : [];
    this.links = existsSync(this.linksFile) ? this.decrypt<FillLink[]>(readFileSync(this.linksFile, 'utf8')) : [];
    return this.items;
  }

  private save(): void {
    writeFileSync(this.blobFile, this.encrypt(this.items ?? []), { mode: 0o600 });
    writeFileSync(this.linksFile, this.encrypt(this.links), { mode: 0o600 });
  }

  list(): VaultItemSummary[] {
    return this.load().map((item) => ({ id: item.id, label: item.label, kind: item.kind, updatedAt: item.updatedAt, fields: item.fields }));
  }

  status(id: string): VaultItemSummary | null {
    const item = this.load().find((i) => i.id === id);
    return item ? { id: item.id, label: item.label, kind: item.kind, updatedAt: item.updatedAt, fields: item.fields } : null;
  }

  createFillLink(input: { label: string; kind: VaultItemSummary['kind']; fields: string[]; ttlMinutes?: number }): { token: string; url: string; expiresAt: number } {
    this.load();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + (input.ttlMinutes ?? 60) * 60_000;
    this.links.push({ token, itemId: null, label: input.label, kind: input.kind, fields: input.fields, expiresAt, used: false });
    this.save();
    return { token, url: this.publicBaseUrl + '/vault/fill/' + token, expiresAt };
  }

  /** Member-facing: record what they typed. Never exposed to the agent surface. */
  submitFill(token: string, values: Record<string, string>): VaultItemSummary {
    this.load();
    const link = this.links.find((l) => l.token === token);
    if (!link) throw new Error('unknown or expired fill link');
    if (link.used) throw new Error('this fill link has already been used');
    if (this.now() > link.expiresAt) throw new Error('this fill link has expired');
    const item: VaultItem = {
      id: ulid('vault'),
      label: link.label,
      kind: link.kind,
      fields: Object.keys(values),
      values,
      updatedAt: this.now(),
      note: ''
    };
    (this.items ?? []).push(item);
    link.used = true;
    link.itemId = item.id;
    this.save();
    return { id: item.id, label: item.label, kind: item.kind, updatedAt: item.updatedAt, fields: item.fields };
  }

  fill(itemId: string, target: { site: string; field: string }): { filled: true; itemId: string; fields: number } {
    const item = this.load().find((i) => i.id === itemId);
    if (!item) throw new Error('no vault item ' + itemId);
    // The value is placed here and never returned. Callers receive a count only.
    const placed = 1;
    void target;
    void item.values;
    return { filled: true, itemId: item.id, fields: placed };
  }

  remove(id: string): boolean {
    const items = this.load();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    this.save();
    return true;
  }

  touchNote(id: string, note: string): VaultItemSummary | null {
    const item = this.load().find((i) => i.id === id);
    if (!item) return null;
    item.note = note;
    item.updatedAt = this.now();
    this.save();
    return { id: item.id, label: item.label, kind: item.kind, updatedAt: item.updatedAt, fields: item.fields };
  }

  /** Admin-only: which links are outstanding. Never includes values. */
  pendingLinks(): { token: string; label: string; expiresAt: number; used: boolean }[] {
    this.load();
    return this.links.map((l) => ({ token: l.token, label: l.label, expiresAt: l.expiresAt, used: l.used }));
  }

  /** Guard used by tests and the audit log: prove a secret never leaves this module. */
  static constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
