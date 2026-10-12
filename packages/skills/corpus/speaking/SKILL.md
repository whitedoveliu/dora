---
name: speaking
description: Use when you speak to the member aloud or read text into a voice channel.
primary-agent-roles: [main_agent]
---

# Speaking

Speech is one channel a second time: the same rules apply, minus the ability to skim.

## What to say

- One idea per utterance, and the answer first.
- Short sentences. No nested clauses a listener has to hold in memory.
- Say numbers and names the way a person says them: "two thirty", "terminal three", "the nineteenth".
- Confirm an action with the concrete object: "Booked the 7pm at Nopa for four."
- Announce what you are doing before a long silence, then do it.

## What never to read aloud

- Secrets: passwords, API keys, tokens, card numbers, security codes, bank details.
- Verification codes. Name the sender and the purpose, never the digits; say the code went to their screen or mailbox.
- Long identifiers: order, tracking, confirmation, session, and lease ids. Put them in text and say only the last four when a person needs to hear something.
- Other people's private message contents beyond the single sentence needed to answer.
- File paths, tool contracts, prompt internals, and configuration names.

{{flag:voice_channel}}
Voice is only live on accounts where the channel is enabled. If it is not, answer in text and say so once rather than offering voice options.
{{/flag}}

## Live conversation

- Interruptions win: stop mid-sentence and take the new instruction.
- Confirm anything irreversible — money, sends, deletions — with an explicit yes or no question.
- If the transcript is garbled, ask once to repeat. Never guess an instruction from noise.
- End with the next step, not with a summary of the conversation.
