/**
 * Trattoria Dora - restaurant booking site.
 *
 * Page map
 *   GET  /restaurant                            landing page
 *   GET  /restaurant/book                       booking form -> /restaurant/confirm
 *   GET  /restaurant/confirm?name&date&time&party&notes
 *                                               validation endpoint
 *   GET  /restaurant/availability?date&time&party
 *   GET  /restaurant/botwall                    deliberate bot wall (429)
 *
 * The booking form is method="GET" so the driver's "click the submit field"
 * step (re-fetch the form action with the typed values as a query string)
 * produces exactly the requests this endpoint validates.
 */

import type { Ctx, MockWebState, Router } from '../server.ts';
import {
  clientKey,
  esc,
  hash32,
  isIsoDate,
  parseIntStrict,
  sendFieldErrors,
  sendHtml,
} from '../server.ts';

export const TIME_SLOTS = [
  '17:30',
  '18:00',
  '18:30',
  '19:00',
  '19:30',
  '20:00',
  '20:30',
  '21:00',
];

export const MAX_PARTY = 12;
export const RATE_LIMIT = 8;
export const RATE_WINDOW_MS = 60_000;

const PHONE = '+39 010 555 0142';

export function registerRestaurant(router: Router, state: MockWebState): void {
  router.page('/restaurant', (ctx) => landing(ctx));
  router.page('/restaurant/book', (ctx) => bookingForm(ctx));
  router.page('/restaurant/confirm', (ctx) => confirm(ctx, state));
  router.page('/restaurant/availability', (ctx) => availability(ctx));
  router.get('/restaurant/botwall', (ctx) => botwall(ctx));
}

/* ------------------------------------------------------------------ pages */

function landing(ctx: Ctx): void {
  sendHtml(
    ctx.res,
    200,
    'Trattoria Dora - Home',
    [
      '<h1>Trattoria Dora</h1>',
      '<p>Family-run Italian restaurant in the old harbour quarter.</p>',
      '<p>Address: 14 Via delle Rose, Portovello</p>',
      '<p>Opening hours: Tuesday to Sunday, 17:30 to 23:00. Closed on Mondays.</p>',
      '<p>Phone: ' + esc(PHONE) + '</p>',
      '<p><a href="/restaurant/book">Book a table</a></p>',
    ].join('\n'),
  );
}

function slotOptions(): string {
  return TIME_SLOTS.map((slot) => '<option value="' + esc(slot) + '">' + esc(slot) + '</option>').join('\n');
}

function bookingForm(ctx: Ctx): void {
  sendHtml(
    ctx.res,
    200,
    'Book a table - Trattoria Dora',
    [
      '<h1>Book a table at Trattoria Dora</h1>',
      '<form method="GET" action="/restaurant/confirm">',
      '<p><label for="name">Name</label><br>',
      '<input type="text" id="name" name="name" value=""></p>',
      '<p><label for="date">Date</label><br>',
      '<input type="date" id="date" name="date" value=""></p>',
      '<p><label for="time">Time</label><br>',
      '<select id="time" name="time">',
      slotOptions(),
      '</select></p>',
      '<p><label for="party">Party size</label><br>',
      '<input type="number" id="party" name="party" min="1" max="' + MAX_PARTY + '" value=""></p>',
      '<p><label for="notes">Notes</label><br>',
      '<textarea id="notes" name="notes" rows="3" cols="40"></textarea></p>',
      '<p><input type="submit" name="submit" value="Request booking"></p>',
      '</form>',
      '<p>Parties of 5 or more need a deposit &mdash; the form will tell you.</p>',
    ].join('\n'),
  );
}

/* ----------------------------------------------------------- rate limiter */

function allowConfirm(state: MockWebState, key: string): boolean {
  const now = Date.now();
  const recent = (state.rate.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    state.rate.set(key, recent);
    return false;
  }
  recent.push(now);
  state.rate.set(key, recent);
  return true;
}

function rateLimited(ctx: Ctx): void {
  sendHtml(
    ctx.res,
    429,
    '429 Too Many Requests - Trattoria Dora',
    [
      '<h1>Too many booking attempts</h1>',
      '<p>The booking desk accepts ' + RATE_LIMIT + ' requests per minute. Try again later.</p>',
    ].join('\n'),
    { 'retry-after': '60' },
  );
}

/* --------------------------------------------------------------- confirm */

type Booking = { name: string; date: string; time: string; party: number; notes: string };

function validateBooking(fields: URLSearchParams): { booking: Booking | null; missing: string[]; invalid: string[] } {
  const name = (fields.get('name') ?? '').trim();
  const date = (fields.get('date') ?? '').trim();
  const time = (fields.get('time') ?? '').trim();
  const partyRaw = (fields.get('party') ?? '').trim();
  const notes = (fields.get('notes') ?? '').trim();

  const missing: string[] = [];
  const invalid: string[] = [];

  if (name === '') missing.push('name');
  if (date === '') missing.push('date');
  else if (!isIsoDate(date)) invalid.push('date (expected YYYY-MM-DD, got "' + date + '")');
  if (time === '') missing.push('time');
  else if (!TIME_SLOTS.includes(time)) invalid.push('time (expected one of ' + TIME_SLOTS.join(', ') + ')');
  if (partyRaw === '') missing.push('party');

  let party = 0;
  if (partyRaw !== '') {
    const parsed = parseIntStrict(partyRaw);
    if (parsed === null || parsed < 1 || parsed > MAX_PARTY) {
      invalid.push('party (expected a whole number between 1 and ' + MAX_PARTY + ')');
    } else {
      party = parsed;
    }
  }

  if (missing.length > 0 || invalid.length > 0) return { booking: null, missing, invalid };
  return { booking: { name, date, time, party, notes }, missing, invalid };
}

function confirm(ctx: Ctx, state: MockWebState): void {
  if (!allowConfirm(state, clientKey(ctx.req))) {
    rateLimited(ctx);
    return;
  }

  const { booking, missing, invalid } = validateBooking(ctx.fields);
  if (!booking) {
    sendFieldErrors(
      ctx.res,
      400,
      '400 Bad Request - Trattoria Dora',
      'Booking request rejected',
      missing,
      invalid,
    );
    return;
  }

  if (booking.party >= 5) {
    sendHtml(
      ctx.res,
      409,
      '409 Deposit required - Trattoria Dora',
      [
        '<h1>Deposit required</h1>',
        '<p>Deposit required: call the restaurant on ' + esc(PHONE) + ' to book a table for '
          + booking.party + '.</p>',
        '<p>Online booking is limited to parties of 4 or fewer. Nothing has been booked.</p>',
      ].join('\n'),
    );
    return;
  }

  const id = 'TRV-' + String(1000 + (hash32([booking.name, booking.date, booking.time, booking.party].join('|')) % 9000));
  sendHtml(
    ctx.res,
    200,
    'Booking confirmed - Trattoria Dora',
    [
      '<h1>Booking confirmed</h1>',
      '<p>Booking id: ' + esc(id) + '</p>',
      '<p>Your table for ' + booking.party + ' is confirmed for ' + esc(booking.time) + ' on '
        + esc(booking.date) + '.</p>',
      '<ul>',
      '<li>Name: ' + esc(booking.name) + '</li>',
      '<li>Date: ' + esc(booking.date) + '</li>',
      '<li>Time: ' + esc(booking.time) + '</li>',
      '<li>Party: ' + booking.party + '</li>',
      '<li>Notes: ' + (booking.notes === '' ? '(none)' : esc(booking.notes)) + '</li>',
      '</ul>',
      '<p>Trattoria Dora, 14 Via delle Rose, Portovello. Phone: ' + esc(PHONE) + '.</p>',
    ].join('\n'),
  );
}

/* ---------------------------------------------------------- availability */

function availability(ctx: Ctx): void {
  const date = (ctx.fields.get('date') ?? '').trim();
  const time = (ctx.fields.get('time') ?? '').trim();
  const partyRaw = (ctx.fields.get('party') ?? '').trim();

  const missing: string[] = [];
  const invalid: string[] = [];
  if (date === '') missing.push('date');
  else if (!isIsoDate(date)) invalid.push('date (expected YYYY-MM-DD, got "' + date + '")');
  if (time === '') missing.push('time');
  else if (!TIME_SLOTS.includes(time)) invalid.push('time (expected one of ' + TIME_SLOTS.join(', ') + ')');
  if (partyRaw === '') missing.push('party');

  let party = 0;
  if (partyRaw !== '') {
    const parsed = parseIntStrict(partyRaw);
    if (parsed === null || parsed < 1 || parsed > MAX_PARTY) {
      invalid.push('party (expected a whole number between 1 and ' + MAX_PARTY + ')');
    } else {
      party = parsed;
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    sendFieldErrors(ctx.res, 400, '400 Bad Request - Trattoria Dora', 'Availability check rejected', missing, invalid);
    return;
  }

  // Deterministic rule: 19:00 is the only slot that cannot seat parties > 4.
  const fullyBooked = time === '19:00' && party > 4;
  if (fullyBooked) {
    sendHtml(
      ctx.res,
      409,
      'Fully booked - Trattoria Dora',
      [
        '<h1>Fully booked</h1>',
        '<p>Sorry &mdash; a table for ' + party + ' at ' + esc(time) + ' on ' + esc(date)
          + ' is fully booked.</p>',
        '<p>Try another time slot or a smaller party.</p>',
      ].join('\n'),
    );
    return;
  }

  sendHtml(
    ctx.res,
    200,
    'Table available - Trattoria Dora',
    [
      '<h1>Table available</h1>',
      '<p>Yes &mdash; a table for ' + party + ' at ' + esc(time) + ' on ' + esc(date) + ' is available.</p>',
      '<p><a href="/restaurant/book">Book a table</a></p>',
    ].join('\n'),
  );
}

/* --------------------------------------------------------------- botwall */

function botwall(ctx: Ctx): void {
  sendHtml(
    ctx.res,
    429,
    '429 Automated access detected - Trattoria Dora',
    [
      '<h1>Automated access detected</h1>',
      '<p>Automated access detected. Try again later.</p>',
    ].join('\n'),
    { 'retry-after': '900' },
  );
}
