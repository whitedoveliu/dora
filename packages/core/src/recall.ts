/**
 * memory_recall.
 *
 * Retrieval over the memory repo: the model never browses the filesystem for this;
 * the runtime selects verbatim excerpts by last_modified and renders them into a
 * <memory_recall> block, injected at the start of every run.
 */

export interface MemorySnippet {
  path: string;
  id: string;
  type: string;
  body: string;
  lastModified: number;
}

export const RECALL_TAG = 'memory_recall';

/** Preamble text carried into the model context ahead of the snippets. */
export const RECALL_PREAMBLE = [
  "Recalled memory snippets: verbatim excerpts from the user's memory files, current as of each item's last_modified date.",
  'Act on them directly — do not re-read these files or sweep memory to confirm what is already shown here. Recall is selective, not comprehensive: search or read memory only for information these snippets do not cover, and check live systems (calendar, email, source-of-truth tools) when the task depends on current external state rather than remembered facts.'
].join(' ');

export interface RecallOptions {
  limit?: number;
  maxCharsPerSnippet?: number;
  now?: number;
  query?: string;
}

/**
 * Selection is by last_modified, newest first. A query boosts lexical overlap but
 * never removes recency from the ordering.
 */
export function selectRecallSnippets(snippets: MemorySnippet[], options: RecallOptions = {}): MemorySnippet[] {
  const limit = options.limit ?? 6;
  const maxChars = options.maxCharsPerSnippet ?? 1200;
  const terms = (options.query ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

  const scored = snippets.map((s) => {
    const haystack = (s.path + ' ' + s.id + ' ' + s.body).toLowerCase();
    const overlap = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
    return { s, overlap };
  });

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return b.s.lastModified - a.s.lastModified;
  });

  return scored.slice(0, limit).map(({ s }) => ({
    ...s,
    body: s.body.length > maxChars ? s.body.slice(0, maxChars) + '\n…[truncated]' : s.body
  }));
}

export function renderRecallBlock(snippets: MemorySnippet[], now = Date.now()): string {
  const head = `<${RECALL_TAG}>`;
  const tail = `</${RECALL_TAG}>`;
  const lines: string[] = [head, RECALL_PREAMBLE, ''];
  if (snippets.length === 0) {
    lines.push('(no memory snippets matched this run)');
  }
  for (const s of snippets) {
    const age = Math.max(0, now - s.lastModified);
    lines.push(`--- ${s.path} (id: ${s.id}, type: ${s.type}, last_modified: ${new Date(s.lastModified).toISOString()}, age_ms: ${age}) ---`);
    lines.push(s.body.trim());
    lines.push('');
  }
  lines.push(tail);
  return lines.join('\n');
}
