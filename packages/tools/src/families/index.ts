import { ToolRegistry } from '../registry.ts';
import { register as time } from './time.ts';
import { register as todos } from './todos.ts';
import { register as tasks } from './tasks.ts';
import { register as orchestration } from './orchestration.ts';
import { register as data } from './data.ts';
import { register as grounding } from './grounding.ts';
import { register as channels } from './channels.ts';
import { register as browser } from './browser.ts';
import { register as connectors, CONNECTOR_FAMILIES } from './connectors.ts';
import { register as extra } from './extra.ts';

interface FamilyMeta {
  name: string;
  title: string;
  description: string;
  connector?: string;
  declaredActions: number;
}

/**
 * Family metadata carries two counts: the actions a family declares, and the actions this
 * build actually routes. The index reports both, next to the family name and whether the
 * connector is connected.
 */
export const FAMILY_META: FamilyMeta[] = [
  { name: 'outlook', title: 'Microsoft Graph mail/calendar/contacts', description: 'Exchange mail, calendar and contacts.', connector: 'outlook', declaredActions: 96 },
  { name: 'notion', title: 'Notion workspace', description: 'Pages and databases.', connector: 'notion', declaredActions: 51 },
  { name: 'google-calendar', title: 'Calendar', description: 'Events, invitations and free time.', connector: 'google-calendar', declaredActions: 45 },
  { name: 'google-drive', title: 'Drive documents', description: 'Files and folders.', connector: 'google-drive', declaredActions: 38 },
  { name: 'gmail', title: 'Mail search, read, write, send', description: 'Gmail.', connector: 'gmail', declaredActions: 37 },
  { name: 'google-sheets', title: 'Spreadsheets', description: 'Sheets and ranges.', connector: 'google-sheets', declaredActions: 31 },
  { name: 'cloud_browser', title: 'Rented browser driving', description: 'Drive a lease.', connector: 'cloud_browser', declaredActions: 27 },
  { name: 'linear', title: 'Project management', description: 'Issues and projects.', connector: 'linear', declaredActions: 27 },
  { name: 'slack', title: 'Slack read/write', description: 'Channels and messages.', connector: 'slack', declaredActions: 27 },
  { name: 'agent-mail', title: 'Agent-owned mailbox', description: 'The agent address at mail.dora.ai.', connector: 'agent-mail', declaredActions: 16 },
  { name: 'google-slides', title: 'Slide decks', description: 'Decks and slides.', connector: 'google-slides', declaredActions: 16 },
  { name: 'google-tasks', title: 'Google Tasks', description: 'Task lists.', connector: 'google-tasks', declaredActions: 16 },
  { name: 'yelp', title: 'Local businesses', description: 'Places and reviews.', connector: 'yelp', declaredActions: 16 },
  { name: 'imessage', title: 'iMessage/SMS', description: 'Threads, reactions, games, voice notes, location.', connector: 'imessage', declaredActions: 15 },
  { name: 'github', title: 'Repositories and issues', description: 'Code, issues, pull requests.', connector: 'github', declaredActions: 12 },
  { name: 'slackbot', title: 'Slack bot identity', description: 'Bot-authored messages.', connector: 'slackbot', declaredActions: 10 },
  { name: 'google-docs', title: 'Documents', description: 'Read and edit documents.', connector: 'google-docs', declaredActions: 10 },
  { name: 'todos', title: 'Durable todos', description: 'Outcome tracking.', declaredActions: 7 },
  { name: 'link_payments', title: 'Payment links', description: 'Request and track payment.', connector: 'link_payments', declaredActions: 7 },
  { name: 'vault', title: 'Credential vault (fill-only)', description: 'Store and place secrets without reading them.', declaredActions: 7 },
  { name: 'granola', title: 'Meeting notes', description: 'Meetings and transcripts.', connector: 'granola', declaredActions: 6 },
  { name: 'links', title: 'Link management', description: 'Short links and stats.', declaredActions: 5 },
  { name: 'tasks', title: 'Task-agent lifecycle', description: 'Delegate, inspect, cancel.', declaredActions: 5 },
  { name: 'cloud_browser_scheduler', title: 'Browser leases', description: 'Acquire, release, extend.', connector: 'cloud_browser', declaredActions: 4 },
  { name: 'wake_schedule', title: 'Clock wakes', description: 'Cadence, clock and cron wakes.', declaredActions: 4 },
  { name: 'whatsappbot', title: 'WhatsApp send / pre-approved templates', description: 'Messages and pre-approved templates.', connector: 'whatsapp', declaredActions: 4 },
  { name: 'maps', title: 'Maps', description: 'Geocoding, routes, places.', declaredActions: 4 },
  { name: 'feedback', title: 'Member feedback', description: 'Report problems with Dora itself.', declaredActions: 3 },
  { name: 'time', title: 'Time and timezone', description: 'All date arithmetic.', declaredActions: 3 },
  { name: 'wake_subscription', title: 'Event subscriptions', description: 'Mail, calendar, docs, location, iMessage.', declaredActions: 3 },
  { name: 'weather', title: 'Weather', description: 'Conditions, forecast, alerts.', declaredActions: 3 },
  { name: 'browser_guidance', title: 'Site field notes', description: 'What worked on a site before.', connector: 'cloud_browser', declaredActions: 3 },
  { name: 'account', title: 'Account info', description: 'Identity and contact details.', declaredActions: 2 },
  { name: 'observations', title: 'Observation index', description: 'SQL and fetch over indexed external data.', declaredActions: 2 },
  { name: 'google-workspace', title: 'Google suite accounts', description: 'Account set health.', connector: 'google-workspace', declaredActions: 2 },
  { name: 'image', title: 'Image generation', description: 'Generate and edit images.', declaredActions: 2 },
  { name: 'agent_message', title: 'Task agent to parent', description: 'Report back with results.', declaredActions: 1 },
  { name: 'flights', title: 'Live flight search', description: 'Flight options.', declaredActions: 1 },
  { name: 'payments', title: 'Payments', description: 'Execute a payment.', declaredActions: 1 }
];

export const SINGLE_ACTIONS = [
  'search', 'web_search', 'web_fetch', 'read', 'speak',
  'steer_voice_agent', 'generate_referral_link', 'revoke_referral_link',
  'skills.list', 'skills.read'
];

export function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const meta of FAMILY_META) {
    r.registerFamily({ name: meta.name, title: meta.title, description: meta.description, connector: meta.connector, declaredActions: meta.declaredActions });
  }
  // Families that exist only as tool groups still get a metadata row.
  r.registerFamily({ name: 'skills', title: 'Skill library', description: 'Descriptions, bodies and references.', declaredActions: 2 });
  for (const register of [time, todos, tasks, orchestration, data, grounding, channels, browser, connectors, extra]) register(r);
  void CONNECTOR_FAMILIES;
  return r;
}
