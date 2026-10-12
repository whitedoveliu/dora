import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { MemoryFile, MemoryService } from '@dora/core';
import { parseDocument, serializeDocument, shouldPromote, wikiLinks, type Frontmatter } from './frontmatter.ts';

export interface MemoryStoreOptions {
  root: string;
  promoteLines?: number;
  /** Disable git commits (used by tests that run without git). */
  noGit?: boolean;
}

/**
 * The memory repo.
 *
 * A git repository of markdown files mounted read-only into the agent sandbox:
 * timeline/, entities/, comms/, workstreams/ and knowledge/. Files describe current
 * state; history is the git log, so no file carries an "updated" field.
 */
export class MemoryStore implements MemoryService {
  private readonly root: string;
  private readonly promoteLines: number;
  private readonly noGit: boolean;

  constructor(options: MemoryStoreOptions) {
    this.root = resolve(options.root);
    this.promoteLines = options.promoteLines ?? 150;
    this.noGit = options.noGit ?? false;
    mkdirSync(this.root, { recursive: true });
    for (const dir of ['timeline/raw', 'timeline/hourly', 'timeline/daily', 'timeline/weekly', 'timeline/monthly', 'entities/people', 'entities/projects', 'entities/tools', 'entities/orgs', 'comms', 'workstreams/active', 'workstreams/completed', 'workstreams/someday', 'knowledge/facts', 'knowledge/procedures', 'knowledge/preferences', 'knowledge/decisions']) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
    if (!this.noGit && !existsSync(join(this.root, '.git'))) this.git(['init', '-q']);
  }

  private git(args: string[]): string | null {
    try {
      return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
  }

  private walk(dir = this.root): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.walk(full));
      else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
  }

  private toFile(full: string): MemoryFile {
    const raw = readFileSync(full, 'utf8');
    const path = relative(this.root, full);
    const parsed = parseDocument(raw, path.replace(/\.md$/, ''));
    return {
      path,
      id: parsed.frontmatter.id,
      type: parsed.frontmatter.type,
      aliases: parsed.frontmatter.aliases,
      body: parsed.body,
      lastModified: statSync(full).mtimeMs
    };
  }

  list(): MemoryFile[] {
    return this.walk()
      .map((f) => this.toFile(f))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  read(path: string): MemoryFile | null {
    const full = resolve(this.root, path);
    if (!full.startsWith(this.root) || !existsSync(full)) return null;
    return this.toFile(full);
  }

  write(path: string, body: string, frontmatter: Record<string, unknown> = {}): MemoryFile {
    if (path.includes('vault') || path.includes('credential') || path.includes('secret')) {
      throw new Error('credentials never enter the memory repo');
    }
    const full = resolve(this.root, path);
    if (!full.startsWith(this.root)) throw new Error('memory path escapes the repo');
    const existing = existsSync(full) ? parseDocument(readFileSync(full, 'utf8'), path.replace(/\.md$/, '')) : null;

    if (existing && shouldPromote(existing.body, this.promoteLines) && !path.endsWith('_index.md')) {
      // Promote to a directory: _index.md keeps the id and aliases so old links hold.
      const dir = full.replace(/\.md$/, '');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '_index.md'), serializeDocument(existing.frontmatter, existing.body), 'utf8');
      return this.write(join(relative(this.root, dir), '_index.md'), body, frontmatter);
    }

    const front: Frontmatter = {
      id: String(frontmatter['id'] ?? existing?.frontmatter.id ?? path.replace(/\.md$/, '')),
      type: String(frontmatter['type'] ?? existing?.frontmatter.type ?? 'note'),
      aliases: (frontmatter['aliases'] as string[]) ?? existing?.frontmatter.aliases ?? [],
      extra: { ...(existing?.frontmatter.extra ?? {}) }
    };
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, serializeDocument(front, body), 'utf8');
    return this.toFile(full);
  }

  search(query: string): MemoryFile[] {
    const needle = query.toLowerCase();
    return this.list().filter((f) => (f.body + ' ' + f.id + ' ' + f.aliases.join(' ')).toLowerCase().includes(needle));
  }

  recent(limit: number): MemoryFile[] {
    return this.list().slice(0, limit);
  }

  /** Resolve [[wiki-links]] to file paths via id or alias. */
  resolveLinks(text: string): { link: string; path: string | null }[] {
    const files = this.list();
    return wikiLinks(text).map((link) => {
      const hit = files.find((f) => f.id === link || f.aliases.includes(link) || f.path.replace(/\.md$/, '') === link);
      return { link, path: hit ? hit.path : null };
    });
  }

  commit(message: string): string | null {
    if (this.noGit) return null;
    this.git(['add', '-A']);
    const out = this.git(['commit', '-q', '-m', message]);
    if (out === null) return null;
    return this.git(['rev-parse', 'HEAD'])?.trim() ?? null;
  }

  /**
   * Roll raw per-minute observations up into hourly and daily summaries
   * (raw/, then hourly, daily, weekly, monthly).
   */
  rollup(now = new Date()): { hourly: string | null; daily: string | null } {
    const rawDir = join(this.root, 'timeline/raw');
    if (!existsSync(rawDir)) return { hourly: null, daily: null };
    const rawFiles = readdirSync(rawDir).filter((f) => f.endsWith('.md'));
    if (rawFiles.length === 0) return { hourly: null, daily: null };
    const hourKey = now.toISOString().slice(0, 13);
    const dayKey = now.toISOString().slice(0, 10);
    const lines = rawFiles.map((f) => {
      const parsed = parseDocument(readFileSync(join(rawDir, f), 'utf8'), f);
      return '- ' + parsed.body.trim().split('\n')[0];
    });
    const hourlyPath = 'timeline/hourly/' + hourKey + '.md';
    const dailyPath = 'timeline/daily/' + dayKey + '.md';
    this.write(hourlyPath, lines.join('\n') + '\n', { id: 'hourly-' + hourKey, type: 'timeline-rollup' });
    const daily = this.read(dailyPath);
    const dailyBody = (daily?.body ?? '') + lines.join('\n') + '\n';
    this.write(dailyPath, dailyBody, { id: 'daily-' + dayKey, type: 'timeline-rollup' });
    return { hourly: hourlyPath, daily: dailyPath };
  }

  stats(): { files: number; bytes: number; lastCommit: string | null } {
    const files = this.walk();
    const bytes = files.reduce((acc, f) => acc + statSync(f).size, 0);
    return { files: files.length, bytes, lastCommit: this.noGit ? null : this.git(['rev-parse', 'HEAD'])?.trim() ?? null };
  }
}
