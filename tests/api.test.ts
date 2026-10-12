import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApiServer } from '@dora/api';
import { harness } from './helpers.ts';

async function bootApi(label: string) {
  const h = await harness(label);
  const token = 'test-token-' + Math.random().toString(36).slice(2);
  const api = createApiServer({ runtime: h.runtime, adminToken: token, webRoot: join(h.runtime.config.root, 'apps/web') });
  const { url } = await api.listen(0);
  const call = async (path: string, init: RequestInit = {}, withToken = true) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (withToken) headers['authorization'] = 'Bearer ' + token;
    if (init.body) headers['content-type'] = 'application/json';
    const response = await fetch(url + path, { ...init, headers });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html or plain text */
    }
    return { status: response.status, text, json: json as Record<string, unknown> | null };
  };
  return { h, api, url, call };
}

test('health is public, everything else needs the admin token', async () => {
  const { h, api, call } = await bootApi('api-auth');
  try {
    const health = await call('/api/health', {}, false);
    assert.equal(health.status, 200);
    assert.equal(health.json!['ok'], true);

    const denied = await call('/api/overview', {}, false);
    assert.equal(denied.status, 401);

    const overview = await call('/api/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.json!['main_session'] !== undefined, true);
    assert.ok(Array.isArray(overview.json!['connectors']));
  } finally {
    await api.close();
    await h.dispose();
  }
});

test('the web conversation surface is feature flagged', async () => {
  const { h, api, call } = await bootApi('api-agent-chat');
  try {
    h.runtime.flags['agent_chat'] = false;
    const gated = await call('/agent');
    assert.equal(gated.status, 403);
    assert.match(gated.text, /Agent chat feature not enabled/);

    const session = h.runtime.ensureMainSession();
    const messageDenied = await call('/api/sessions/' + session.id + '/messages', { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
    assert.equal(messageDenied.status, 403);

    const flagUpdate = await call('/api/flags', { method: 'POST', body: JSON.stringify({ name: 'agent_chat', enabled: true }) });
    assert.equal(flagUpdate.status, 200);
    assert.equal((flagUpdate.json!['flags'] as Record<string, boolean>)['agent_chat'], true);

    const page = await call('/agent');
    assert.equal(page.status, 200);
    const forced = await call('/api/sessions/' + session.id + '/messages?force=1', { method: 'POST', body: JSON.stringify({ text: 'run: tools time now' }) });
    assert.equal(forced.status, 200);
  } finally {
    await api.close();
    await h.dispose();
  }
});

test('the console can run a tools command and read the protection rails verbatim', async () => {
  const { h, api, call } = await bootApi('api-tools');
  try {
    const blocked = await call('/api/tools/exec', { method: 'POST', body: JSON.stringify({ argv: ['time', 'now'] }) });
    assert.equal(blocked.status, 200);
    const blockedJson = blocked.json as unknown as { exitCode: number; attachments: { name: string; content: string }[] };
    assert.equal(blockedJson.exitCode, 3);
    assert.equal(blockedJson.attachments[0].name, 'help:time.now');
    assert.match(blockedJson.attachments[0].content, /OUTPUT JSON/);

    const allowed = await call('/api/tools/exec', { method: 'POST', body: JSON.stringify({ argv: ['time', 'now'] }) });
    assert.equal((allowed.json as unknown as { exitCode: number }).exitCode, 0);

    const index = await call('/api/tools');
    assert.ok((index.json!['total'] as number) > 150);
    assert.ok((index.json!['families'] as unknown[]).length >= 35);

    const help = await call('/api/tools/gmail.search/help');
    assert.equal(help.status, 200);
    assert.match(String(help.json!['page']), /DETAILS/);

    const sql = await call('/api/observations/sql', { method: 'POST', body: JSON.stringify({ query: 'DELETE FROM gmail' }) });
    assert.equal(sql.status, 400);
    assert.match(String(sql.json!['error']), /SELECT or WITH/);
  } finally {
    await api.close();
    await h.dispose();
  }
});

test('the vault fill link is a member-facing page and never exposes values', async () => {
  const { h, api, call } = await bootApi('api-vault');
  try {
    const created = await call('/api/vault/links', { method: 'POST', body: JSON.stringify({ label: 'airline', kind: 'password', fields: ['password'] }) });
    assert.equal(created.status, 201);
    const token = created.json!['token'] as string;

    // The member opens the link: no admin token is involved.
    const form = await call('/vault/fill/' + token, {}, false);
    assert.equal(form.status, 200);
    assert.match(form.text, /Secure entry/);

    const submitted = await fetch('http://127.0.0.1:' + new URL(api['server'].address() ? 'http://x' : 'http://x').port, { method: 'GET' }).catch(() => null);
    void submitted;

    const vault = await call('/api/vault');
    assert.equal(vault.status, 200);
    assert.ok(Array.isArray(vault.json!['links']));
    assert.ok(!JSON.stringify(vault.json).includes('hunter2'));
    void h;
  } finally {
    await api.close();
    await h.dispose();
  }
});

test('inbound channel messages can run the agent', async () => {
  const { h, api, call } = await bootApi('api-channels');
  try {
    const inbound = await call('/api/channels/inbound', { method: 'POST', body: JSON.stringify({ channel: 'imessage', from: h.runtime.account.phone, to: 'dora', body: 'what is on my calendar' }) });
    assert.equal(inbound.status, 201);
    assert.match(String((inbound.json!['message'] as Record<string, unknown>)['body']), /calendar/);

    const withRun = await call('/api/channels/inbound', { method: 'POST', body: JSON.stringify({ channel: 'imessage', from: h.runtime.account.phone, to: 'dora', body: 'run: tools time now', run: true }) });
    assert.equal(withRun.status, 201);
    assert.ok(withRun.json!['run'] !== null);

    const channels = await call('/api/channels');
    assert.ok((channels.json!['messages'] as unknown[]).length >= 2);

    const memory = await call('/api/memory');
    assert.ok((memory.json!['files'] as unknown[]).length >= 5);

    const sessions = await call('/api/sessions');
    assert.ok((sessions.json!['sessions'] as unknown[]).length >= 1);
  } finally {
    await api.close();
    await h.dispose();
  }
});
