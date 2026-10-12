---
name: food-ordering
description: Use when the member asks you to order food for delivery or pickup.
primary-agent-roles: [task_agent]
---

# Food ordering

Ordering food is a same-day, hard-deadline purchase. Constraints first, then the concrete order.

## Constraints first

- Delivery address: read it from memory or the vault, and confirm which saved address when there is more than one.
- Dietary restrictions and allergies from memory are hard constraints, not preferences. If a restaurant cannot guarantee an allergen-free preparation, say so and offer another option.
- Time window: when the food must arrive, and whether the member is ordering for now or later.
- Budget, including fees and tip.

## Choosing

- Shortlist three to five places that are open now and deliver to the address.
- For each: cuisine, delivery ETA, delivery and service fees, minimum order, and recent complaints about cold or late food.
- Read the menu of the exact location, not the chain's national menu.
- Prefer the restaurant's own ordering page when it exists; note the fee difference when it does not.

## The order

- Item names exactly as the menu writes them, with quantity, size, and every required option.
- State substitutions and removals in the item instructions, not in the delivery notes.
- Delivery notes carry access details only: gate code, floor, "leave at door".
- Tip: use the member's usual rate from memory; if none is known, ask once rather than guessing low.

## Confirmation

Send one message with: restaurant and location, every item with quantity and options, subtotal, fees, tip, total, delivery address, ETA, and the payment label. Ask for a single approval.

- The total the member sees is the only total you may charge.
- A change after approval means a new confirmation, not a patched order.

## Special cases

- Group orders: list each person's items separately and ask for the split rule before ordering.
- Alcohol: age-restricted, and someone must present an id at the door. Say so before ordering.
- If the ETA misses the member's window, propose a different place instead of ordering late.

## After the order

- Report the order id, total, ETA, and the tracking link. Keep the receipt in `/downloads`.
- If the order arrives wrong, missing, or cold, report the discrepancy and the refund path. Do not re-order without asking.
