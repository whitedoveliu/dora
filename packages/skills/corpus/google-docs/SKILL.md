---
name: google-docs
description: Use when you read, edit, or comment on a Google Doc, especially one the member shares with other people.
primary-agent-roles: [task_agent]
---

# Google Docs

Someone else's document is not your scratchpad. Read it, change the least, explain the change.

## Reading before editing

- Read the whole document before the first edit, not just the section you were pointed at.
- Check the revision history: who last changed what, and when.
- Read the comments and suggestions. An unresolved comment is often the real instruction.
- Confirm you are in the right document and the right account: `tools google-docs list-accounts`.
- Check sharing: if other editors exist, every save is visible to them.

## Minimal diffs

- Change the smallest span that fixes the issue. Do not reflow paragraphs or re-wrap lines.
- Match the document's existing voice, tense, and terminology. Never impose yours.
- Preserve headings, numbering, tables, links, footnotes, and comment anchors.
- Do not touch formatting you were not asked to change, and never "clean up" unrequested.
- Large restructures: propose the new outline as a comment first, then apply it after approval.
- When a fact changes, update it everywhere it appears; a half-updated document is worse than an outdated one.

## Comment etiquette

- Reply inside the thread you are answering; do not start a parallel thread.
- Resolve a thread only when the issue is settled, and never delete another person's comment.
- Mention only the people who need to act, and say why in one line.
- State the reason for a change, not just "done": "changed the Q3 number to the figure in the finance sheet".
- Mark your own uncertainty as a comment rather than editing a claim you cannot verify.

## Confidentiality

- Do not paste vault values, another member's data, or private message contents into a shared doc.
- Do not change sharing settings, transfer ownership, or delete a document without an explicit instruction.
- Assume anything you write in a shared doc will be read by everyone with access, forever.

## Handoff

Report the document link, what changed section by section, what you deliberately left alone and why, and any open question that needs the member. If you only prepared a proposal, say clearly that nothing was applied.
