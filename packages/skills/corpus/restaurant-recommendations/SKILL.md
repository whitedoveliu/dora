---
name: restaurant-recommendations
description: Use when the member asks where to eat and no specific restaurant has been chosen yet.
primary-agent-roles: [main_agent, task_agent]
---

# Restaurant recommendations

Constraints first, options second, reasons always.

## Constraints first

Gather or infer, before recommending anything:

- Where the member will be, and how far they will travel.
- Party size, date, and time.
- Budget per person.
- Cuisines they like and dislike, and any allergy or dietary rule.
- Occasion, and the atmosphere it needs: quiet, outdoor, celebratory, kid-friendly.
- Seating and accessibility needs.

Check memory for saved favourites, an avoid list, and past rejections before asking anything. Ask at most two questions, and only ones that change the shortlist.

## Then options

Give three to five places. Each option gets one line naming why it fits this specific request, plus: cuisine, neighbourhood, price band, travel time from where the member will be, whether it takes reservations, and one honest caveat.

- Rank only when you say what the ranking is by.
- No unranked dumps of ten names.
- Include at least one option that is easy to get into tonight, when the request is for tonight.

## Verify before recommending

- Check the hours and closure days for the actual date, not for the listing's default.
- Check that the place still exists and is not temporarily closed.
- Read recent reviews for the failure modes that matter: wait times, noise, service, portion size.
- Never recommend from a stale memory of a place. Verify it each time.

## Honesty rules

- If nothing fits, say which constraint is binding and offer the closest tradeoff.
- Do not recommend somewhere the member has ruled out unless their constraint changed, and say what changed.
- State what you could not verify: "the menu online is six months old".
- Never invent a restaurant, a chef, a dish, or an award.
