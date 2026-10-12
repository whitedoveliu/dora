---
name: shopping
description: Use when the member asks you to research, compare, or buy a physical or digital product.
primary-agent-roles: [task_agent]
---

# Shopping

Buying is irreversible. Research freely, confirm concretely.

## Frame the purchase

- What it is for, the hard constraints, the nice-to-haves, the budget ceiling, and the deadline.
- Check memory first for sizes, brands, addresses, past returns, and compatibility constraints. Ask only what memory does not cover.
- Write the constraint list down before searching. It is what stops an attractive wrong item.

## Research

- Build three to six candidates. For each: exact variant, seller, price, shipping, return window, warranty.
- Use the seller's own page for price and stock; the manufacturer's specification for compatibility; reviews only for failure modes.
- Record the URL of the exact variant, never the category page you started from.
- Note the difference between the listing and the checkout. The checkout is the truth.

## Total landed cost

| Line | What to include |
| --- | --- |
| Item | The exact variant and quantity |
| Tax | The rate at the delivery address |
| Shipping | Fastest affordable option, and the free-tier ETA |
| Duties and fees | For cross-border orders |
| Required extras | Cables, filters, subscriptions, activation fees, accessories needed to use it |
| Return cost | Return shipping and restocking fees when a return is plausible |

A cheaper item that needs a required accessory is not cheaper. Compare the totals, then compare the risk.

## Deciding

- With a budget and constraints given, choose one and present it with one runner-up and the reason each fits.
- If nothing meets the ceiling, say which constraint is binding and offer the tradeoff. Never quietly downgrade.
- If two options are close, say what the extra money buys, in one line.

## Final-state confirmation

Before any purchase, show one message containing: the exact item and variant, quantity, seller, total charged today, shipping address, delivery estimate, return policy, and the payment method label.

- The member must see that block and approve it. A general "buy it for me" is not approval for a specific purchase.
- Never read or type card numbers. Vault items are fill-only; the member stores and you place.
- Never select a saved payment method the member did not name.
- Never add a subscription, insurance, or an extended warranty unless the member asked for it.

{{flag:link_payments}}
A payment link is a delivery of the same confirmation, not a shortcut around it. Send it only after the member has seen the final state, and never for an amount they have not approved.
{{/flag}}

## After the purchase

- Keep the order confirmation in `/downloads`. Report the order id, the total, the ETA, and the return deadline.
- Schedule a wake for the delivery date and one for the return window closing, when a return is plausible.
- If the order arrives wrong or late, report the discrepancy and the refund path; do not re-order without asking.
