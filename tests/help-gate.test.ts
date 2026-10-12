import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.ts';

test('help gate blocks the first call with exit code 3 and attaches the contract', async () => {
  const h = await harness('gate');
  try {
    const blocked = await h.invoke(['time', 'now', '--timezone', 'UTC']);
    assert.equal(blocked.exitCode, 3);
    assert.match(blocked.stdout, /help usage contract must be read before it's called/);
    assert.equal(blocked.attachments.length, 1);
    assert.equal(blocked.attachments[0].name, 'help:time.now');
    assert.match(blocked.attachments[0].content, /DETAILS/);
    assert.match(blocked.attachments[0].content, /USAGE/);
    assert.match(blocked.attachments[0].content, /OPTIONS/);
    assert.match(blocked.attachments[0].content, /OUTPUT JSON/);

    const allowed = await h.invoke(['time', 'now', '--timezone', 'UTC']);
    assert.equal(allowed.exitCode, 0);
    assert.match(allowed.stdout, /now:/);
  } finally {
    await h.dispose();
  }
});

test('built-ins do not need their contract read first', async () => {
  const h = await harness('gate-builtin');
  try {
    const index = await h.invoke(['help']);
    assert.equal(index.exitCode, 0);
    assert.equal(index.attachments[0].name, 'help:index');
    assert.match(index.attachments[0].content, /action index/);

    const asyncList = await h.invoke(['async', 'list']);
    assert.equal(asyncList.exitCode, 0);
  } finally {
    await h.dispose();
  }
});

test('help batches are capped and report what was not attached', async () => {
  const h = await harness('gate-batch');
  try {
    const targets = ['time.now', 'time.convert', 'time.diff', 'todos.list', 'todos.create', 'todos.update', 'todos.complete', 'todos.drop', 'todos.get', 'todos.stats'];
    const result = await h.invoke(['help', ...targets]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.attachments.length, h.runtime.config.helpBatchLimit);
    assert.match(result.stdout, /not attached \(too many pages\)/);
  } finally {
    await h.dispose();
  }
});

test('a connector that is not connected yields a status line instead of a contract', async () => {
  const h = await harness('gate-connector', { seed: false });
  try {
    const result = await h.invoke(['help', 'gmail.search']);
    assert.equal(result.attachments.length, 1);
    assert.match(result.attachments[0].content, /^STATUS unavailable: gmail is not connected/);
    assert.doesNotMatch(result.attachments[0].content, /OUTPUT JSON/);
  } finally {
    await h.dispose();
  }
});

test('redirecting stdout to a file loses the attachment', async () => {
  const h = await harness('gate-redirect');
  try {
    await h.invoke(['help', 'time.now']); // read the contract so the call is allowed
    const direct = await h.bash('tools time now');
    assert.equal(direct.exitCode, 0);
    const redirected = await h.bash('tools help gmail.search > help.txt');
    assert.equal(redirected.attachments.length, 0);
    assert.match(redirected.stderr, /attachment dropped: stdout was redirected/);
  } finally {
    await h.dispose();
  }
});
