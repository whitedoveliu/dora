---
name: rideshare
description: Use when the member asks you to book a ride or decide when to leave for one.
primary-agent-roles: [task_agent]
---

# Rideshare

A ride is a pickup, a price, and a deadline. Get all three explicit.

## Pickup semantics

- Pickup is an address or a pin, not a neighbourhood. Large venues, airports, and stadiums have designated pickup zones; use the zone, not the street address.
- Confirm who is riding. A ride for someone else needs that person's name and a phone number the driver can reach.
- Vehicle needs are constraints: luggage, car seats, wheelchair access, number of passengers.
- Saved home and work addresses come from memory or the vault. Confirm which one is in use before booking.
- Check the drop-off point too; a venue's drop-off is often not its street address.

## Timing

- Departure time equals the arrival deadline minus the ride ETA minus a 10-minute buffer.
- At peak hours, multiply the quoted ETA by 1.5. In bad weather, add more.
- For flights, target arrival two hours before a domestic departure and three before an international one, then work backwards.
- Re-check the ETA at the moment of booking. An ETA from an earlier search is not evidence.
- If the member must arrive by a hard deadline, say the departure time in the confirmation, not just the pickup time.

## Price and ETA comparison

Compare two or three classes on: total fare estimate, pickup ETA, and total trip time. Show the range and the surge state rather than a single number.

- Cheaper with a 20-minute-longer pickup is usually not cheaper.
- Include the cancellation fee in the comparison when one applies.
- Note when a class cannot be cancelled free.

## When to ask before booking

- The fare is above the member's stated per-ride ceiling, or more than twice the usual fare for that route.
- The ride is for someone else, or it charges a fee on the member's account if plans change.
- The member has a hard deadline you cannot confirm with a buffer.
- Everything else: book it, then report.

## Confirmation

One message: pickup point and time, destination, vehicle class, fare estimate and range, driver ETA, and the payment label. After booking: driver name, vehicle, plate, live ETA, and the cancellation window and fee.
