---
name: deep-research
description: Use when a question needs multiple sources, conflicting evidence must be weighed, or the answer will feed a decision with money, legal, or health stakes.
primary-agent-roles: [main_agent, task_agent]
---

# Deep research

Bounded lookups are not research. If one source answers the question, answer it and stop. Run this skill when the answer needs several sources, when sources disagree, or when the decision carries real stakes.

## Step 1 — Decompose

1. Write the decision the research serves, in one sentence. If there is no decision, you are browsing.
2. Write 3-7 sub-questions, each answerable by evidence.
3. For each sub-question, name the evidence type that would settle it: a primary document, a dataset, a first-hand account, an expert.
4. Answer what the member's own context already covers first — memory, observations, connected documents — before going to the open web.
5. Mark what you will do if a sub-question stays unanswered.

## Step 2 — Climb the source ladder

| Tier | Sources | How to use |
| --- | --- | --- |
| 1 | Official documents, filings, datasets, the actual page or contract | Settles a factual claim |
| 2 | First-hand statements from the party involved, their own release | Settles what a party says |
| 3 | Expert secondary work, established trade press, peer-reviewed papers | Fills gaps and interprets tier 1 |
| 4 | Aggregators, wikis, listicles, SEO explainers | Finding only, never settling |
| 5 | Forums, social posts, unattributed screenshots | Leads only; always chase to tier 1 or 2 |

Two tier-3 sources do not outrank one tier-1 source. Never let a tier-4 page be the only support for a claim you present as fact. See `references/source-quality.md` for the full ladder and the checks that catch stale or copy-pasted sources.

## Step 3 — Citation discipline

- Cite the URL exactly as the search returned it. Do not shorten, reconstruct, or guess a URL.
- One citation per claim, at the claim.
- Quote exactly. Mark elisions with ellipses. Never present a paraphrase as a quote.
- Record the access date with `tools time`.
- If a sentence has no source, label it as your inference in the text itself.

## Step 4 — Handle contradictions

- Keep both claims. Do not average them and do not silently pick one.
- Check for a definitional difference first: different metric, period, population, or unit. Many contradictions are two different questions.
- State which claim has better evidence and why, then say what would settle it.
- If it stays open, give the range and the condition under which each end is true.
- Never present a contested number as settled because it appeared first or most often.

## Step 5 — Stop on rules, not on fatigue

- Stop when every sub-question has an answer at or above its required tier.
- Stop when two further searches return nothing new.
- Cap yourself at three passes over the same sub-question, then report the gap instead.
- Report the gaps as findings; an honest "unresolved" beats a confident patch.

## Step 6 — Deliver

- Answer first, in the member's terms.
- Evidence second, ordered by tier, with the citation at each claim.
- Then confidence, what would change the answer, and what you could not verify.
- Keep the source list complete; a link dump is not a source list if claims are not tied to it.

## Reporting provenance to the parent

Report claims with their sources, not a list of URLs. For each finding: claim, tier, URL, and whether it is settled or contested. Name the assumptions you made when a sub-question was underdetermined.
