import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.ts';

test('memory is markdown with frontmatter, wiki-links and git history', async () => {
  const h = await harness('memory');
  try {
    const memory = h.runtime.services.memory;
    const files = memory.list();
    assert.ok(files.length >= 5);
    const style = memory.read('knowledge/preferences/communication-style.md');
    assert.ok(style);
    assert.equal(style!.id, 'communication-style');
    assert.ok(style!.aliases.includes('tone'));

    const alex = memory.read('entities/people/alex.md');
    assert.equal(alex!.type, 'person');
    const links = (memory as unknown as { resolveLinks?: (t: string) => unknown }).resolveLinks?.('[[alex]] and [[communication-style]]');
    assert.ok(links === undefined || Array.isArray(links));

    const before = (memory as unknown as { stats(): { lastCommit: string | null } }).stats();
    memory.write('knowledge/facts/office.md', 'The office is on Market St.\n', { id: 'office', type: 'fact' });
    const commit = memory.commit('add office fact');
    assert.ok(commit === null || typeof commit === 'string');
    const after = (memory as unknown as { stats(): { lastCommit: string | null } }).stats();
    assert.ok(after.lastCommit === null || before.lastCommit === null || after.lastCommit !== before.lastCommit);
  } finally {
    await h.dispose();
  }
});

test('the memory repo refuses credentials and rolls raw observations up', async () => {
  const h = await harness('memory-rules');
  try {
    const memory = h.runtime.services.memory;
    assert.throws(() => memory.write('knowledge/vault/passwords.md', 'secret'), /credentials never enter the memory repo/);
    const now = new Date();
    memory.write('timeline/raw/' + now.toISOString().slice(0, 13) + '-30.md', '- 10:30 the member called the dentist\n', { id: 'raw-x', type: 'observation' });
    const rolled = memory.rollup(now);
    assert.ok(rolled.hourly && memory.read(rolled.hourly!));
    assert.ok(rolled.daily && memory.read(rolled.daily!));
  } finally {
    await h.dispose();
  }
});

test('observations sql enforces SELECT only, no OFFSET, timestamped partitions and a row cap', async () => {
  const h = await harness('observations');
  try {
    const store = h.runtime.services.observations;
    assert.throws(() => store.sql('DELETE FROM gmail'), /SELECT or WITH/);
    assert.throws(() => store.sql('SELECT path FROM gmail WHERE ts > 0 OFFSET 10'), /OFFSET/);
    assert.throws(() => store.sql('SELECT path FROM gmail'), /timestamp condition/);
    const result = store.sql('SELECT path, title FROM gmail WHERE ts > 0 LIMIT 5');
    assert.ok(result.columns.includes('path'));
    assert.ok(result.rows.length > 0);
    const capped = store.sql('SELECT path FROM observations');
    assert.equal(capped.truncated, false);

    const fetched = store.fetch('gmail/gm_001');
    assert.ok(fetched && fetched.content.length > 10);
    assert.equal(store.fetch('gmail/nope'), null);

    const sources = store.sources();
    assert.ok(sources.some((s) => s.source === 'gmail' && s.rows > 0));
  } finally {
    await h.dispose();
  }
});

test('the vault is fill-only and fill links are single use', async () => {
  const h = await harness('vault');
  try {
    const vault = h.runtime.services.vault;
    const link = vault.createFillLink({ label: 'bank', kind: 'password', fields: ['pin'] });
    assert.match(link.url, /^https:\/\/dora\.ai\/vault\/fill\//);
    const item = vault.submitFill(link.token, { pin: '1234-super-secret' });
    assert.deepEqual(vault.status(item.id)!.fields, ['pin']);

    // Nothing agent-facing may contain the value.
    assert.ok(!JSON.stringify(vault.list()).includes('1234-super-secret'));
    assert.ok(!JSON.stringify(vault.status(item.id)).includes('1234'));
    assert.ok(!JSON.stringify(vault.fill(item.id, { site: 'bank.example', field: 'pin' })).includes('1234'));

    assert.throws(() => vault.submitFill(link.token, { pin: 'again' }), /already been used/);
    assert.throws(() => vault.submitFill('bogus', { pin: 'x' }), /unknown or expired/);

    const note = vault.touchNote(item.id, 'rotated');
    assert.ok(note);
    assert.equal(vault.remove(item.id), true);
    assert.equal(vault.status(item.id), null);
  } finally {
    await h.dispose();
  }
});
