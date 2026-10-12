import type { ToolRegistry } from '../registry.ts';
import { define, list, opt, requireArg, str, type ActionSpec } from './_helpers.ts';

/** Small connector families that only need their catalogue shape and a working core. */
const specs: ActionSpec[] = [
  { family: 'google-slides', name: 'create', summary: 'Create a deck.', trait: 'work', connector: 'google-slides', options: [opt('--title', 'string', 'Deck title', { required: true })], outputJson: '{id:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.put('google-slides', 'deck', { title: requireArg(args, '--title') });
    return { stdout: 'created ' + rec.externalId + '\n', json: { id: rec.externalId } };
  } },
  { family: 'google-slides', name: 'add-slide', summary: 'Append a slide with a title and bullets.', trait: 'work', connector: 'google-slides', options: [opt('--id', 'string', 'Deck id', { required: true }), opt('--title', 'string', 'Slide title', { required: true }), opt('--bullets', 'string[]', 'Bullet lines')], outputJson: '{slides:int}', handler: async (_ctx, args) => ({ stdout: 'slide added\n', json: { slides: 1, title: str(args, '--title'), bullets: list(args, '--bullets') } }) },
  { family: 'google-slides', name: 'read', summary: 'Read a deck as an outline.', trait: 'work', connector: 'google-slides', options: [opt('--id', 'string', 'Deck id', { required: true })], outputJson: '{id:str,outline:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.records('google-slides', 'deck', { externalId: requireArg(args, '--id') })[0];
    if (!rec) throw new Error('no deck ' + str(args, '--id'));
    return { stdout: rec.body, json: { id: rec.externalId, outline: rec.body } };
  } },

  { family: 'slackbot', name: 'post', summary: 'Post as the Dora bot identity rather than as the member.', trait: 'work', connector: 'slackbot', options: [opt('--channel', 'string', 'Channel', { required: true }), opt('--text', 'string', 'Text', { required: true })], outputJson: '{id:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.put('slackbot', 'message', { title: str(args, '--channel') ?? '', body: requireArg(args, '--text') });
    return { stdout: 'posted ' + rec.externalId + '\n', json: { id: rec.externalId } };
  } },
  { family: 'slackbot', name: 'dm', summary: 'Direct-message the member from the bot identity.', trait: 'work', connector: 'slackbot', options: [opt('--user', 'string', 'User id', { required: true }), opt('--text', 'string', 'Text', { required: true })], outputJson: '{id:str}', handler: async (ctx, args) => {
    const rec = ctx.services.connectors.put('slackbot', 'message', { title: str(args, '--user') ?? '', body: requireArg(args, '--text') });
    return { stdout: 'sent ' + rec.externalId + '\n', json: { id: rec.externalId } };
  } },
  { family: 'slackbot', name: 'react', summary: 'Add a reaction with the bot identity.', trait: 'work', connector: 'slackbot', options: [opt('--channel', 'string', 'Channel', { required: true }), opt('--ts', 'string', 'Message timestamp', { required: true }), opt('--emoji', 'string', 'Emoji name', { required: true })], outputJson: '{ok:bool}', handler: async () => ({ stdout: 'reacted\n', json: { ok: true } }) },

  { family: 'google-workspace', name: 'accounts', summary: 'Google accounts connected to this member, and which is the default.', trait: 'work', connector: 'google-workspace', outputJson: '{accounts:[{id:str,label:str,is_default:bool}]}', handler: async (ctx) => {
    const accounts = ctx.services.connectors.accounts().filter((a) => a.connector.startsWith('google-'));
    return { stdout: accounts.map((a) => a.id + '  ' + a.connector + '  ' + a.label).join('\n') + '\n', json: { accounts } };
  } },
  { family: 'google-workspace', name: 'status', summary: 'Health of the Google connector set.', trait: 'work', connector: 'google-workspace', outputJson: '{connected:int,missing:[str]}', handler: async (ctx) => {
    const wanted = ['google-calendar', 'google-drive', 'google-docs', 'google-sheets', 'google-tasks', 'google-slides'];
    const missing = wanted.filter((c) => !ctx.services.connectors.isConnected(c));
    return { stdout: (missing.length ? 'missing: ' + missing.join(', ') : 'all connected') + '\n', json: { connected: wanted.length - missing.length, missing } };
  } }
];

export function register(registry: ToolRegistry): void {
  for (const spec of specs) registry.register(define(spec));
}
