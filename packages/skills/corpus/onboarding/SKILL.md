---
name: onboarding
description: Use during the member's first run, when you need to learn who they are, connect their services, and set up the first outcomes.
primary-agent-roles: [main_agent]
---

# Onboarding

The first run has one job: leave the member with a working agent and one real outcome in motion. It is a conversation, not a form.

## Order

1. **Identity and address.** Name, what to call them, timezone, preferred language.
2. **Channel.** Which channel they are on now and where they want updates.
3. **Context.** What they do, what a normal week holds, who matters in it.
4. **Priorities.** The one to three outcomes they want held this month.
5. **Connections.** Mail first, then calendar, then messages and documents as they use them.
6. **Preferences.** Communication style, approvals, quiet hours, anything they hate.
7. **Memory write.** Everything durable goes to memory before you move on.
8. **First win.** Do one real thing end to end today, however small.

Do not reorder. Each step makes the next one cheaper, and connections made before priorities are connections nobody uses.

## What to learn

| Topic | Why it matters | Where it lands |
| --- | --- | --- |
| Name and address form | Every message starts here | Memory: identity |
| Timezone and working hours | Every schedule and wake depends on it | Memory: preferences |
| Language and register | Writing as them later | Memory: communication style |
| Priorities this month | The first todos and the first wake | Todos and memory |
| Key people | Threads, scheduling, context | Memory: entities |
| Constraints | Allergies, accessibility, budgets, hard noes | Memory: preferences |
| Approval appetite | What they want to see before it happens | Memory: preferences |

## What to connect

- Connector accounts are added locally with a fixture or token. There is no OAuth ceremony to run.
- `tools <connector> list-accounts` is the only source of truth about the default account. Never assume from memory.
- One connector at a time. Confirm it produced data before starting the next.
- Ask, then verify. An account named in conversation is not the same as the account the tool reports.
- Never ask for a password, a code, or a card number in chat. Vault items are fill-only and the member stores them through the vault form.
- If a connector fails twice, move on and note it instead of grinding.

{{flag:agent_mail}}
Offer the agent mailbox as the address for services that should not use the member's personal address.
{{/flag}}
{{flag:whatsapp_channel}}
If WhatsApp is enabled, confirm whether the member wants it as a channel or only as a way to reach other people.
{{/flag}}
{{flag:imessage_channel}}
If iMessage is enabled, confirm the number or address the member wants to be reached on.
{{/flag}}

## What to set up

- One wake schedule for the daily check-in, at a time the member names.
- A wake subscription only when a real event source exists; do not invent one.
- Todos for the priorities, written as outcomes rather than activities.
- A communication-style file in memory once you have seen two or three real messages.

## Conversation rules

- Three to five questions per turn, highest value first. One message, not an interview.
- Every answer becomes a memory write before the next question.
- No feature tour, no marketing language, no disclaimer paragraph.
- Mirror the member's brevity. If they answer in three words, ask shorter questions.
- Stop onboarding when you have the first outcome and a working channel; the rest can be learned on the job.

## Done criteria

- Memory holds identity, timezone, language, channel, priorities, and style.
- At least one connector is connected, verified with `list-accounts`, and produced data.
- One wake is scheduled and the member knows when it fires.
- One todo that matters exists, and the member knows what happens next.
- The member has seen one real thing completed on their behalf.
