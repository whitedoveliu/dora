/**
 * Dora Air - flight search site.
 *
 * Page map
 *   GET /flights                        search form -> /flights/results
 *   GET /flights/results?from&to&date   three deterministic options
 *   GET /flights/book?flight=<id>&from&to&date
 *
 * Prices come from an FNV-1a hash of from+to+date, so they are stable for a
 * given search but not hardcoded. Option 3 is deliberately absurd: two stops
 * and exactly +$900 over the direct option, so "pick the best" has one clear
 * answer (the non-stop option 1, which is also the cheapest).
 */

import type { Ctx, MockWebState, Router } from '../server.ts';
import { esc, hash32, isIsoDate, sendFieldErrors, sendHtml, usd } from '../server.ts';
import type { FlightRecord } from '../server.ts';

export type FlightOption = FlightRecord;

export function optionsFor(from: string, to: string, date: string): FlightOption[] {
  const seed = hash32([from.trim().toLowerCase(), to.trim().toLowerCase(), date.trim()].join('|'));
  const base = 120 + (seed % 280);
  const firstId = 1000 + (seed % 8997);
  const ids = [firstId, firstId + 1, firstId + 2].map((n) => 'DA-' + String(n));
  return [
    {
      id: ids[0] as string,
      from,
      to,
      date,
      depart: '08:15',
      arrive: '10:05',
      stops: 0,
      price: base,
    },
    {
      id: ids[1] as string,
      from,
      to,
      date,
      depart: '12:40',
      arrive: '17:55',
      stops: 1,
      price: base + 140 + ((seed >>> 5) % 90),
    },
    {
      id: ids[2] as string,
      from,
      to,
      date,
      depart: '06:05',
      arrive: '23:50',
      stops: 2,
      price: base + 900,
    },
  ];
}

export function bookHref(option: FlightOption): string {
  const params = new URLSearchParams({
    flight: option.id,
    from: option.from,
    to: option.to,
    date: option.date,
  });
  return '/flights/book?' + params.toString();
}

export function registerFlights(router: Router, state: MockWebState): void {
  router.page('/flights', (ctx) => search(ctx));
  router.page('/flights/results', (ctx) => results(ctx, state));
  router.page('/flights/book', (ctx) => book(ctx, state));
}

/* ------------------------------------------------------------------ pages */

function search(ctx: Ctx): void {
  sendHtml(
    ctx.res,
    200,
    'Dora Air - Flight search',
    [
      '<h1>Dora Air</h1>',
      '<p>Search flights between two cities.</p>',
      '<form method="GET" action="/flights/results">',
      '<p><label for="from">From</label><br>',
      '<input type="text" id="from" name="from" value=""></p>',
      '<p><label for="to">To</label><br>',
      '<input type="text" id="to" name="to" value=""></p>',
      '<p><label for="date">Date</label><br>',
      '<input type="date" id="date" name="date" value=""></p>',
      '<p><input type="submit" name="submit" value="Search flights"></p>',
      '</form>',
    ].join('\n'),
  );
}

function results(ctx: Ctx, state: MockWebState): void {
  const from = (ctx.fields.get('from') ?? '').trim();
  const to = (ctx.fields.get('to') ?? '').trim();
  const date = (ctx.fields.get('date') ?? '').trim();

  const missing: string[] = [];
  const invalid: string[] = [];
  if (from === '') missing.push('from');
  if (to === '') missing.push('to');
  if (date === '') missing.push('date');
  else if (!isIsoDate(date)) invalid.push('date (expected YYYY-MM-DD, got "' + date + '")');

  if (missing.length > 0 || invalid.length > 0) {
    sendFieldErrors(ctx.res, 400, '400 Bad Request - Dora Air', 'Flight search rejected', missing, invalid);
    return;
  }

  const options = optionsFor(from, to, date);
  for (const option of options) state.flights.set(option.id, option);

  const rows = options.map((option) =>
    '<tr>'
    + '<td>' + esc(option.id) + ' <a href="' + esc(bookHref(option)) + '">Book</a></td>'
    + '<td>' + esc(option.depart) + '</td>'
    + '<td>' + esc(option.arrive) + '</td>'
    + '<td>' + option.stops + '</td>'
    + '<td>' + esc(usd(option.price)) + '</td>'
    + '</tr>',
  ).join('\n');

  sendHtml(
    ctx.res,
    200,
    'Flights ' + from + ' to ' + to + ' - Dora Air',
    [
      '<h1>Flights from ' + esc(from) + ' to ' + esc(to) + ' on ' + esc(date) + '</h1>',
      '<table>',
      '<thead>',
      '<tr><th>flight</th><th>depart</th><th>arrive</th><th>stops</th><th>price</th></tr>',
      '</thead>',
      '<tbody>',
      rows,
      '</tbody>',
      '</table>',
      '<p>Prices are per passenger in USD and include taxes.</p>',
      '<p><a href="/flights">Search again</a></p>',
    ].join('\n'),
  );
}

function book(ctx: Ctx, state: MockWebState): void {
  const flightId = (ctx.fields.get('flight') ?? '').trim();
  if (flightId === '') {
    sendFieldErrors(ctx.res, 400, '400 Bad Request - Dora Air', 'Booking rejected', ['flight']);
    return;
  }

  const from = (ctx.fields.get('from') ?? '').trim();
  const to = (ctx.fields.get('to') ?? '').trim();
  const date = (ctx.fields.get('date') ?? '').trim();

  let option: FlightOption | null = null;
  if (from !== '' && to !== '' && date !== '' && isIsoDate(date)) {
    option = optionsFor(from, to, date).find((candidate) => candidate.id === flightId) ?? null;
    if (!option) {
      sendHtml(
        ctx.res,
        404,
        '404 Unknown flight - Dora Air',
        [
          '<h1>Unknown flight</h1>',
          '<p>Flight <code>' + esc(flightId) + '</code> does not serve ' + esc(from) + ' to ' + esc(to)
            + ' on ' + esc(date) + '.</p>',
          '<p><a href="/flights">Search again</a></p>',
        ].join('\n'),
      );
      return;
    }
  } else {
    option = state.flights.get(flightId) ?? null;
    if (!option) {
      sendHtml(
        ctx.res,
        404,
        '404 Unknown flight - Dora Air',
        [
          '<h1>Unknown flight</h1>',
          '<p>No flight with id <code>' + esc(flightId) + '</code>. Search first, then book from the results.</p>',
          '<p><a href="/flights">Search again</a></p>',
        ].join('\n'),
      );
      return;
    }
  }

  sendHtml(
    ctx.res,
    200,
    'Book ' + option.id + ' - Dora Air',
    [
      '<h1>Flight ' + esc(option.id) + '</h1>',
      '<p>Final state: flight ' + esc(option.id) + ' on ' + esc(option.date) + ' for '
        + esc(usd(option.price)) + '</p>',
      '<ul>',
      '<li>From: ' + esc(option.from) + '</li>',
      '<li>To: ' + esc(option.to) + '</li>',
      '<li>Date: ' + esc(option.date) + '</li>',
      '<li>Depart: ' + esc(option.depart) + '</li>',
      '<li>Arrive: ' + esc(option.arrive) + '</li>',
      '<li>Stops: ' + option.stops + '</li>',
      '<li>Price: ' + esc(usd(option.price)) + '</li>',
      '</ul>',
      '<p><a href="/flights">Search again</a></p>',
    ].join('\n'),
  );
}
