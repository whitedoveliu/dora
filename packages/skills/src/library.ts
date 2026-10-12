import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyFlagPlaceholders, type FlagMap, type SkillRecord, type SkillService } from '@dora/core';

/**
 * The three-layer skill system.
 *
 *   description  -> returned by the skills action; decides *when* a skill applies
 *   SKILL.md     -> the body; decides *how*
 *   references   -> named inside the body and read on demand
 *
 * A skill also declares primary-agent-roles, and its body may carry {{flag:...}} blocks
 * that the server substitutes per account before the text reaches the model.
 */
export interface SkillLibraryOptions {
  /** The shipped corpus (packages/skills/corpus). */
  platformDir: string;
  /** The account's skills directory, mounted at /skills in the sandbox. */
  accountSkillsDir: string;
  /** Role filter for the personal skills, if any. */
  now?: () => number;
}

interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  roles: ('main_agent' | 'task_agent')[];
  dir: string;
  body: string;
  references: string[];
}

function parseFrontmatter(raw: string): { front: Record<string, string | string[]>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { front: {}, body: raw };
  const front: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    front[key] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : value.replace(/^["']|["']$/g, '');
  }
  return { front, body: raw.slice(match[0].length) };
}

export class SkillLibrary implements SkillService {
  private readonly platformDir: string;
  private readonly accountSkillsDir: string;
  private loaded: LoadedSkill[] | null = null;

  constructor(options: SkillLibraryOptions) {
    this.platformDir = options.platformDir;
    this.accountSkillsDir = options.accountSkillsDir;
    this.sync();
  }

  /** Mirror the shipped corpus into the account skills directory (/skills/platform). */
  sync(): number {
    const target = join(this.accountSkillsDir, 'platform');
    mkdirSync(target, { recursive: true });
    mkdirSync(join(this.accountSkillsDir, 'personal'), { recursive: true });
    if (!existsSync(this.platformDir)) return 0;
    let copied = 0;
    for (const entry of readdirSync(this.platformDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = join(this.platformDir, entry.name);
      if (!existsSync(join(from, 'SKILL.md'))) continue;
      cpSync(from, join(target, entry.name), { recursive: true });
      copied += 1;
    }
    this.loaded = null;
    return copied;
  }

  private load(): LoadedSkill[] {
    if (this.loaded) return this.loaded;
    const out: LoadedSkill[] = [];
    const scan = (root: string) => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        const file = join(dir, 'SKILL.md');
        if (!existsSync(file)) continue;
        const raw = readFileSync(file, 'utf8');
        const { front, body } = parseFrontmatter(raw);
        const referencesDir = join(dir, 'references');
        const references = existsSync(referencesDir) ? readdirSync(referencesDir).filter((f) => f.endsWith('.md')) : [];
        const roles = (front['primary-agent-roles'] as string[] | undefined) ?? ['main_agent', 'task_agent'];
        out.push({
          id: String(front['name'] ?? entry.name),
          name: String(front['name'] ?? entry.name),
          description: String(front['description'] ?? ''),
          roles: roles.filter((r): r is 'main_agent' | 'task_agent' => r === 'main_agent' || r === 'task_agent'),
          dir,
          body,
          references
        });
      }
    };
    scan(join(this.accountSkillsDir, 'platform'));
    scan(join(this.accountSkillsDir, 'personal'));
    this.loaded = out.sort((a, b) => a.id.localeCompare(b.id));
    return this.loaded;
  }

  list(role?: 'main_agent' | 'task_agent'): SkillRecord[] {
    return this.load()
      .filter((s) => !role || s.roles.includes(role))
      .map((s) => ({ id: s.id, name: s.name, description: s.description, roles: s.roles, hasBody: s.body.trim().length > 0, references: s.references }));
  }

  read(id: string, flags: FlagMap): { id: string; body: string; references: string[] } | null {
    const skill = this.load().find((s) => s.id === id || s.name === id);
    if (!skill) return null;
    return { id: skill.id, body: applyFlagPlaceholders(skill.body, flags), references: skill.references };
  }

  readReference(id: string, reference: string, flags: FlagMap): string | null {
    const skill = this.load().find((s) => s.id === id || s.name === id);
    if (!skill) return null;
    const file = join(skill.dir, 'references', reference);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return applyFlagPlaceholders(readFileSync(file, 'utf8'), flags);
  }

  /** Skill ids whose descriptions deserve a mention for a role. */
  descriptionsFor(role: 'main_agent' | 'task_agent'): { id: string; description: string }[] {
    return this.list(role).map((s) => ({ id: s.id, description: s.description }));
  }
}
