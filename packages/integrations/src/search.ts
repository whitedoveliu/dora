import type { SearchResult, SearchService } from '@dora/core';

/**
 * Public web search and fetch.
 *
 * Grounding rules live in the prompt; this service only has to return real URLs. The
 * deployment default is a keyless HTML endpoint so a fresh checkout works; set
 * DORA_SEARCH_ENDPOINT to point at a paid API instead.
 */
export interface HttpSearchOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export class HttpSearchService implements SearchService {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: HttpSearchOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.DORA_SEARCH_ENDPOINT ?? 'https://lite.duckduckgo.com/lite/?q=';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'Mozilla/5.0 (compatible; DoraAgent/1.0; +https://dora.ai)';
  }

  async search(query: string, options: { limit?: number } = {}): Promise<SearchResult[]> {
    const response = await this.fetchImpl(this.endpoint + encodeURIComponent(query), { headers: { 'user-agent': this.userAgent } });
    if (!response.ok) throw new Error('search endpoint returned ' + response.status);
    const html = await response.text();
    const results: SearchResult[] = [];
    const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /class="result-snippet"[^>]*>([\s\S]*?)<\//gi;
    const snippets: string[] = [];
    for (const m of html.matchAll(snippetRe)) snippets.push(stripHtml(m[1]));
    let i = 0;
    for (const m of html.matchAll(linkRe)) {
      results.push({ url: decodeHtml(m[1]), title: stripHtml(m[2]), snippet: snippets[i] ?? '' });
      i += 1;
      if (results.length >= (options.limit ?? 5)) break;
    }
    if (results.length === 0) {
      // Fallback shape used by the html.duckduckgo.com endpoint.
      const altRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
      for (const m of html.matchAll(altRe)) {
        const url = decodeHtml(m[1]);
        if (url.includes('duckduckgo.com')) continue;
        results.push({ url, title: stripHtml(m[2]), snippet: '' });
        if (results.length >= (options.limit ?? 5)) break;
      }
    }
    return results;
  }

  async fetch(url: string): Promise<{ url: string; status: number; contentType: string; text: string }> {
    const response = await this.fetchImpl(url, { headers: { 'user-agent': this.userAgent }, redirect: 'follow' });
    const raw = await response.text();
    const contentType = response.headers.get('content-type') ?? 'text/plain';
    const text = contentType.includes('html') ? stripHtml(raw) : raw;
    return { url: response.url || url, status: response.status, contentType, text: text.slice(0, 200000) };
  }
}

/** Deterministic service for tests and offline runs. */
export class OfflineSearchService implements SearchService {
  async search(query: string): Promise<SearchResult[]> {
    return [{ url: 'https://dora.ai/offline-search?q=' + encodeURIComponent(query), title: 'offline search: ' + query, snippet: 'no network search backend configured' }];
  }
  async fetch(url: string): Promise<{ url: string; status: number; contentType: string; text: string }> {
    return { url, status: 200, contentType: 'text/plain', text: 'offline fetch stub for ' + url };
  }
}

function stripHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
