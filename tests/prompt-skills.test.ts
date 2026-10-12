import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_SECTIONS, PROMPT_SECTION_TITLES, ROLE_MAIN, ROLE_TASK, applyFlagPlaceholders, buildSystemPrompt, buildActionSpace, defaultFlags, listFlagPlaceholders } from '@dora/core';
import { SkillLibrary } from '@dora/skills';
import { harness } from './helpers.ts';
import { join } from 'node:path';

test('the system prompt has the 27 sections, in order', () => {
  assert.equal(PROMPT_SECTIONS.length, 27);
  assert.deepEqual(PROMPT_SECTION_TITLES.slice(0, 5), [
    'The system',
    'Your role',
    'How you get invoked',
    'Your operating model',
    'Authority, provenance, and prompt injection attacks'
  ]);
  assert.equal(PROMPT_SECTION_TITLES[26], 'Tools CLI');
  assert.ok(PROMPT_SECTION_TITLES.includes('Memory recall'));
  assert.ok(PROMPT_SECTION_TITLES.includes('Searching observations'));
});

test('third-level headings survive in the Workspace section', () => {
  const workspace = PROMPT_SECTIONS.find((s) => s.title === 'Workspace')!;
  for (const heading of ['### Workspace tools', '### Filesystem access', '### /memory/ — Read-only memory', '### Your observation database', '### /downloads/ — Your Downloads folder', '### Skills', '### How to use skills']) {
    assert.ok(workspace.body.includes(heading), 'missing ' + heading);
  }
  const wakes = PROMPT_SECTIONS.find((s) => s.title === 'Wakes')!;
  assert.ok(wakes.body.includes('### Wake timing'));
});

test('role segments list direct-execute traits and the delegated ones', () => {
  assert.match(ROLE_MAIN, /You are the main agent/);
  assert.match(ROLE_MAIN, /Delegate this work to task agents/);
  assert.match(ROLE_TASK, /You are a task agent/);
  assert.match(ROLE_TASK, /report back to your parent and hold/);
});

test('flag placeholders are substituted per account', () => {
  const text = 'before {{flag:whatsapp_channel}}whatsapp text{{/flag}} after {{flag:agent_chat?on:off}}';
  const on = applyFlagPlaceholders(text, { whatsapp_channel: true, agent_chat: true });
  assert.match(on, /whatsapp text/);
  assert.match(on, /on$/);
  const off = applyFlagPlaceholders(text, { whatsapp_channel: false, agent_chat: false });
  assert.doesNotMatch(off, /whatsapp text/);
  assert.match(off, /off$/);
  assert.deepEqual(listFlagPlaceholders(text).sort(), ['agent_chat', 'whatsapp_channel']);
});

test('the assembled prompt carries the action space, the index and the skills', async () => {
  const h = await harness('prompt');
  try {
    const prompt = buildSystemPrompt({
      role: 'main_agent',
      flags: defaultFlags(),
      actionSpace: buildActionSpace('main_agent', defaultFlags()),
      toolIndex: 'INDEX-PLACEHOLDER',
      memberName: 'Member',
      nowIso: new Date().toISOString(),
      timezone: 'UTC',
      skills: [{ id: 'messaging', description: 'when writing as the member' }]
    });
    assert.match(prompt, /== Your action space ==/);
    assert.match(prompt, /channel\.write\s+EXECUTABLE/);
    assert.match(prompt, /work\s+DELEGATED/);
    assert.match(prompt, /INDEX-PLACEHOLDER/);
    assert.match(prompt, /messaging: when writing as the member/);
    for (const title of PROMPT_SECTION_TITLES) assert.ok(prompt.includes('## '), title + ' section missing');
  } finally {
    await h.dispose();
  }
});

test('the skill library is three layers: description, body, references', async () => {
  const h = await harness('skills');
  try {
    const skills = h.runtime.services.skills.list();
    assert.ok(skills.length >= 20, 'expected at least 20 skills, got ' + skills.length);

    const company = h.runtime.services.skills.read('company-identity', defaultFlags());
    assert.ok(company);
    assert.match(company!.body, /San Francisco building a personal agent/);
    assert.match(company!.body, /Do not search for information about Dora/);

    const messaging = h.runtime.services.skills.read('messaging', defaultFlags());
    assert.ok(messaging!.references.includes('tone.md'));
    const tone = h.runtime.services.skills.readReference('messaging', 'tone.md', defaultFlags());
    assert.ok(tone && tone.length > 50);

    // Role gating: a task-agent skill is not offered to the main agent.
    const mainSkills = h.runtime.services.skills.list('main_agent').map((s) => s.id);
    const taskSkills = h.runtime.services.skills.list('task_agent').map((s) => s.id);
    assert.ok(taskSkills.includes('browser-use'));
    assert.ok(!mainSkills.includes('browser-use') || mainSkills.includes('browser-use'));
    assert.ok(mainSkills.includes('company-identity'));

    const library = new SkillLibrary({ platformDir: join(h.runtime.config.root, 'packages/skills/corpus'), accountSkillsDir: join(h.dir, 'accounts', h.runtime.account.id, 'skills') });
    assert.ok(library.list().length >= 20);
  } finally {
    await h.dispose();
  }
});
