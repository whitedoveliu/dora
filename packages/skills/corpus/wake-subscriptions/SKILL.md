---
name: wake-subscriptions
description: Use when you decide how to watch a future signal, choosing an event subscription or a scheduled wake, and when to cancel what you created.
primary-agent-roles: [main_agent, task_agent]
---

# Wake subscriptions

Pick the mechanism by the shape of the signal, then own the cleanup.

## Choose the mechanism

- **Wake subscription** (`tools wake_subscription subscribe`): Use when the signal is a supported source event — an email arrives, a calendar event changes, a doc changes, an inbound iMessage message arrives, or the user arrives at a watched place.
- **Wake schedule** (`tools wake_schedule create`): Use when the signal is a time — a deadline or follow-up window — or when the source isn't subscribable for this user.
- **Safety net is automatic**: you do not need to pair a subscription with your own timeout — every subscription comes with an automatic safety check-in.

## Who may subscribe

- Task agents subscribe directly with `wake_subscription.subscribe` on the sources the platform supports.
{{flag:supervisor_subscription_wakes}}
The main agent may hold a supervisor subscription on this account. Use it only for signals the member's own session owns, and unsubscribe when the outcome closes.
{{/flag}}
- When the main agent cannot subscribe and the signal is an event, delegate the watch to a task agent instead of polling.

## Design a subscription

- Choose the source, then the narrowest filter that still catches the event. A filter that matches everything is a schedule with extra steps.
- Set the check-in frequency deliberately. The default is 1440 minutes; shorten it only when silence itself is the risk the member cares about.
- The subscription does not expire. Write down who owns cancellation and what ends it: the outcome completing, the thread closing, or the deadline passing.
- One subscription per source and filter. Never subscribe twice to the same thing.
- Do not stack a polling wake on top of a subscription. If there is a real deadline, add exactly one backup wake at the deadline.

## Design a schedule

- Cadence: `--schedule-interval` in minutes, 5 to 10080. The first fire lands inside one interval. Prefer the longest interval that meets the need.
- Clock: `--at` or `--schedule-cron`, both of which require `--schedule-threshold`, the lateness the member tolerates. 0 means exact.
- Conditional: `--schedule-trigger` carries a natural-language condition the platform evaluates before the wake fires. A condition that does not hold skips the run; it does not fail it.
- `--prompt` is a thin per-wake instruction, not the durable task. Put the task in the durable text.

## On each wake

1. Confirm the event actually matches the filter before acting; a wake is a hint, not a verdict.
2. Do the work, then decide whether the member needs to know.
3. When the outcome is done or the thread closed, cancel: `tools wake_subscription unsubscribe --id`, or `tools wake_schedule cancel --id`.
4. List what you own regularly. A subscription nobody consumes spends wakes forever.

## Failure modes to avoid

- **Subscribing to a source that is not supported** for this member instead of scheduling a check.
- **A filter so narrow it misses** the real event, or so wide that every newsletter wakes you.
- **Two mechanisms for one signal**, which produces duplicate work and duplicate messages.
- **No owner.** Every subscription needs a name attached to its cancellation.
