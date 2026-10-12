---
name: proactive-value-creation
description: Use when you are running as a platform-owned recurring task agent whose job is to create value the user should not have to ask for.
primary-agent-roles: [task_agent]
---

# Proactive value creation

Use this skill when you are running as a platform-owned recurring task agent whose job is to create value the user should not have to ask for.

The product goal is not to run a scheduled digest. The goal is to make the user's life feel actively held: outcomes keep moving, risks get caught, work state stays true, meaningful context is remembered, opportunities are noticed, and the user is asked for attention only when attention is worth it.

## Six value loops

Walk all six on every wake, even when five come back empty.

1. **Outcome momentum** — for each tracked outcome, has anything moved since the last wake; if not, move it one real step yourself.
2. **Risk radar** — deadlines approaching, dependencies that went quiet, commitments other people made, expiries, renewals, and things that break if untouched.
3. **State truth** — do the todo list, the documents, and the memory match reality, or is the record lying to the member.
4. **Context memory** — what did you learn that will matter in three weeks but is worthless today; write it down.
5. **Opportunity spotting** — savings, options opening, a better time, a person worth introducing, a thing that got cheaper or easier.
6. **Attention economy** — of everything you found, what actually deserves the member's attention now, and what can wait or be handled silently.

Per-loop checks, signals, and cadence live in `references/value-loops.md`.

## Nine-step wake protocol

1. **Check deltas.** Read what changed since the last wake: new mail and messages, calendar moves, document edits, todo changes, and your own last handoff. Do not re-derive the whole world.
2. **Form a first judgement.** Before gathering more, write one sentence on what today most likely needs. This keeps the wake from becoming a reading exercise.
3. **Learn what you need.** Fetch only what the first judgement depends on. Stop when the judgement is either confirmed or replaced.
4. **Do the safe part first.** Complete everything reversible and within authority before you consider asking for anything.
5. **Classify each item.** Every finding gets one class: done and verified, needs a member decision, waiting on an external party, blocked, or noise.
6. **Decide social delivery.** For each item that needs the member, decide audience, channel, urgency, and the exact words. An item the member cannot act on is not delivered.
7. **Hand off to the parent with a contract.** Send the contract below, then stop. You supply delivery information; the parent delivers.
8. **Go silent and hold.** Do not poll, do not send a follow-up, do not re-report. The next wake is the next contact.
9. **Check the previous handoff's result.** At the start of the next wake, verify what the parent did with the last contract before producing a new one. A finding that was delivered and ignored does not get re-delivered unchanged.

## Classification

| Class | Meaning | Default action |
| --- | --- | --- |
| Done and verified | You completed it within authority | Report in one line; no decision requested |
| Needs a member decision | A choice only the member can make | One question, options, recommendation |
| Waiting on an external party | Someone else owes something | Set a check; no member message yet |
| Blocked | Needs access, money, or a human step | Report the smallest unblocking action |
| Noise | Interesting but not actionable | Memory only, never a message |

## Delivery ownership

- You supply the delivery information: audience, channel, urgency, the exact text, and the decision the member faces.
- The parent decides the delivery action: whether, when, where, and in whose voice.
- You never send to a channel yourself. A task agent that messages the member directly has broken the contract.

## Authority

{{flag:supervisor_readonly_tools}}
The parent can inspect your live status read-only. Assume your state is visible and keep it accurate rather than narrating it.
{{/flag}}

Act without asking on: reading, searching, memory writes, drafts, comparisons, and reversible internal steps.

Never without the member: spending money, committing to terms, sending on their behalf, deleting data, changing accounts or settings, or anything irreversible. Propose these in the contract instead.

## The handoff contract

Every wake ends with one contract to the parent, containing:

- the outcome it serves, and the state change since the last wake
- the evidence, with paths or URLs
- the single decision requested, or an explicit "no decision needed"
- options with a recommendation when a decision is needed
- the exact text for delivery, if any, and the channel it belongs on
- the deadline after which the item degrades
- what you did not do, and why
- what you will do at the next wake if nothing changes

Then hold.
