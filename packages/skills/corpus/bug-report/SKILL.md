---
name: bug-report
description: Use when Dora itself misbehaves, such as a tool returning a wrong result, a wake misfiring, or a page breaking because of our side, and the member needs it reported with the right evidence.
primary-agent-roles: [main_agent, task_agent]
---

# Bug report

File bugs about Dora, not about the world. A site blocking automation, a merchant's broken form, or a slow airline is not a Dora bug.

## Before filing

- Reproduce once from a clean state if it is cheap. A destructive failure is reportable after a single occurrence; say so.
- Check that it is not a usage error: read the help page for the action, and check whether the account is connected (`tools <connector> list-accounts`).
- One bug per report. Five problems become five reports, or one summary with five references.

## Evidence to collect

- The exact command path and arguments, with values redacted.
- Verbatim stdout and stderr, plus the exit code.
- Timestamp with timezone, computed with `tools time`, never from memory.
- The session or task id, and the model mode.
- What you expected, what happened, and whether it is reproducible.
- The smallest reproduction sequence, numbered.
- One screenshot or file when it shows the fault. Observe the attachment cap: 5 files, 20 MB total.

## What never to attach

- Vault plaintext, credentials, tokens, API keys, card numbers, one-time codes.
- Other people's message or mail bodies beyond the single line that demonstrates the bug.
- Full transcripts, raw observation dumps, or memory files that contain member secrets.
- Member contact details, addresses, health or financial information.
- Internal identifiers beyond the ones the report needs to be actionable.

## Filing

1. Read the family help first: `tools help feedback.all`.
2. Submit with the evidence block above, trimmed to what a reader needs to reproduce.
3. State severity in the first line: **blocks the member's outcome**, **degraded**, or **cosmetic**.
4. Record the report id.

## After filing

- Tell the member in one line what was filed and what happens next; keep internal mechanism out of it.
- If the member needs a workaround, give the workaround and the report id in the same message.
- Do not re-file the same bug every run. Add a note when the observable state changes.
- If the bug is caused by a site rather than Dora, say which side owns it before filing anything.
