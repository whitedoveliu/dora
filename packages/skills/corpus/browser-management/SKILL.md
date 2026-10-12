---
name: browser-management
description: Use when you acquire, extend, release, or contend for a rented cloud browser lease, or when guidance tokens and shared write leases decide who may drive.
primary-agent-roles: [main_agent, task_agent]
---

# Browser management

A rented browser is a lease, not a resource you own. Reading a lease and driving it are separate permissions, and one lease is one browser session.

## Lease lifecycle

1. **Check first.** List existing leases before acquiring. Do not stack two leases for the same site and account.
2. **Acquire.** `tools cloud_browser_scheduler acquire` returns a `lease_id`. Pass the guidance token when the site requires one.
3. **Drive.** `tools cloud_browser.*` with the `lease_id`. The behaviour model lives in the browser-use skill.
4. **Extend** before long work, not after a failure.
5. **Release** when the job is done, blocked, or handed back.

A lease left open blocks siblings, burns quota, and keeps an authenticated session alive that nobody is watching.

{{flag:cloud_browser}}
Physical input to the member's own machine is a different capability and is unavailable unless the local browser is attached. Do not attempt it silently; report the need instead.
{{/flag}}

## State words

| You see | Meaning | Action |
| --- | --- | --- |
| moved, recovered, reconnected | The same lease is alive | Continue; re-snapshot before acting |
| no active session, lease expired | The lease is gone | Acquire again and re-establish state |
| lease limit reached | Another holder exists | Coordinate, do not retry blindly |

## Shared write lease contention

Two agents may read the same authenticated session. Only one may write to it. When task agents contend, the main agent picks one of three moves:

| Move | When | How |
| --- | --- | --- |
| Free the holder | The holder is stuck, finished, or lower value | Ask the holder to release, or cancel the task and release its leases |
| Reprioritize | One job has a deadline the other does not | Tell the loser to hold and give it the lease after the winner submits |
| Make one wait | No deadline pressure, one write path | Loser schedules a wake for the handover instead of polling |

Rules for the coordinator:

- Never let two agents type into the same authenticated session.
- Never cancel a holder mid-submit; wait for the submit to resolve.
- A waiting agent holds; it does not spin, and it does not acquire a second lease to route around the block.
- When you release someone else's lease, say so in the handoff.

## Guidance tokens

- Before driving a site for a real flow, search the guidance library: `tools browser_guidance search` for the site and flow.
- The search result carries a `guidance_token`. Pass it on acquire. When enforcement is on, a missing token is a hard stop, not a suggestion; when the call demands one, do not proceed without it.
- **Missing guidance means unknown.** It is not permission and not prohibition; proceed carefully and record what happens.
- After the flow, record the outcome per configuration, site, and flow: `tools browser_guidance record`, success or failure, with the exact step that failed. This is what makes the next run cheaper.

## Failure handling

- Two consecutive identical lease failures: stop and report. Do not loop.
- Capture the last good URL and a screenshot before releasing a broken lease.
- Release leases on the cancel path; the parent owns cleanup and should not have to sweep after you.
- Account for the 45-second cap on a single shell call when you script waits around a page.

## Reporting

Report to the parent: lease id, site and account, what you completed, current state word, what you released, and what still needs a browser. If you are holding a lease open deliberately, say why and when you will release it.
