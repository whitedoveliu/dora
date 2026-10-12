---
name: scheduling
description: Use when the member asks to schedule, move, or protect time on their calendar, or when a conflict, buffer, or travel time decides the answer.
primary-agent-roles: [main_agent, task_agent]
---

# Scheduling

Calendar judgement, not calendar typing. Compute every time, then decide with the framework below.

## Grounding

- Get now, the timezone, and every conversion from `tools time`. Never from memory, and never from an earlier point in this session.
- Read the member's calendar and the other attendees' availability before proposing anything.
- Check the series, not just the instance, for recurring events.
- Treat declined invitations as free and tentative ones as busy.
- Timezones travel with the invite; state the zone in the proposal when attendees differ.

## Conflict framework

| Situation | Judgement |
| --- | --- |
| Attendee already booked | Hard conflict. Do not propose; find another slot |
| Member has a protected focus block | Treat it as a meeting unless the member says otherwise |
| Back-to-back with no gap | Soft conflict. Propose, but say the gap is zero |
| Conflict with a recurring series | Resolve the series, not the single instance |
| Two of the member's own events overlap | Ask which one wins; do not silently drop one |
| Event outside working hours | Allowed only if the member set that pattern themselves |

## Buffers and travel

- Default 10 minutes between meetings; 15 when either side is external.
- Get travel time from `tools maps`. Multiply by 1.5 at peak hours, and add 15 minutes for parking or security.
- Two in-person meetings more than 20 minutes apart on foot, or with no realistic transit, are a conflict even when the clock allows it.
- Add travel blocks on both sides of an in-person meeting, and never book over them.

## What to propose versus what to book

| Situation | Action |
| --- | --- |
| Member's own calendar, internal, under 30 minutes, no other attendees | Book it and report |
| Attendees already agreed on a window | Propose two or three slots inside it, book on confirmation |
| New person, cold outreach, or an external first meeting | Draft the invite and ask before sending |
| Anything involving money, contracts, or a person the member has not met | Ask before any invite goes out |
| Moving or cancelling someone else's event | Always ask, even when the new time is obviously better |
| A meeting whose purpose the member has not stated | Ask for the purpose; do not invent an agenda |

## Invite hygiene

- Title says what the meeting is. Agenda in the description, with the decision it should reach.
- Location or link present, and correct for the attendees' locations.
- Attendees are only the people who need to be there; check for assistants and delegates.
- One reminder wake for anything more than three days out.
- After booking, report: what, when, with whom, where, and what the member owes the meeting.

## Rescheduling

- Move the fewest people and keep the original duration unless asked.
- Say why in the update when the other side is external.
- If a hard conflict appears after booking, tell the member before you touch the event.
