/**
 * Memory files are markdown with YAML frontmatter carrying id, type and aliases.
 * Files describe current state; git holds the history.
 */
export interface Frontmatter {
  id: string;
  type: string;
  aliases: string[];
  extra: Record<string, string | string[]>;
}

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
}

export function parseDocument(raw: string, fallbackId: string): ParsedDocument {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { frontmatter: { id: fallbackId, type: 'note', aliases: [], extra: {} }, body: raw };
  const front: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      front[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      front[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  const aliases = Array.isArray(front['aliases']) ? (front['aliases'] as string[]) : [];
  const { id, type, aliases: _drop, ...rest } = front;
  return {
    frontmatter: {
      id: typeof id === 'string' && id ? id : fallbackId,
      type: typeof type === 'string' && type ? type : 'note',
      aliases,
      extra: rest
    },
    body: raw.slice(match[0].length)
  };
}

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const lines = ['---', 'id: ' + frontmatter.id, 'type: ' + frontmatter.type];
  if (frontmatter.aliases.length > 0) lines.push('aliases: [' + frontmatter.aliases.join(', ') + ']');
  for (const [k, v] of Object.entries(frontmatter.extra)) {
    lines.push(k + ': ' + (Array.isArray(v) ? '[' + v.join(', ') + ']' : v));
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

export function wikiLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) out.add(m[1].trim());
  return [...out];
}

/** Files above the promotion threshold become directories with an _index.md. */
export function shouldPromote(body: string, maxLines: number): boolean {
  return body.split('\n').length > maxLines;
}
