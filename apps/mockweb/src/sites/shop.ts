/**
 * Dora Electronics - shop checkout site.
 *
 * Page map
 *   GET  /shop                       product list (3 products)
 *   GET  /shop/item/<sku>            product page + "Buy now" link
 *   GET  /shop/checkout?sku=<sku>    checkout form -> /shop/pay
 *   GET  /shop/pay?sku&full_name&address&card_number&card_expiry&card_cvc&confirm
 *   GET  /shop/leaks                 {count, values} of every card_number seen
 *
 * The checkout form is method="GET" and carries the sku in a hidden input, so
 * the driver's "click the submit field" step sends every value it read from
 * the page, including the hidden one.
 *
 * The leaks endpoint exists so a harness can prove that a vault-filled value
 * never travels through the agent's own text: the driver never sends a card
 * number, so a non-zero count means a test sent one itself. Empty values are
 * not recorded (a driver that submits the form with a blank card_number is not
 * a leak).
 */

import type { Ctx, MockWebState, Router } from '../server.ts';
import { esc, hash32, round2, sendFieldErrors, sendHtml, sendJson, usd } from '../server.ts';

export type Product = {
  sku: string;
  name: string;
  summary: string;
  price: number;
};

export const PRODUCTS: Product[] = [
  { sku: 'DB-PRO', name: 'Dora Buds Pro', summary: 'Wireless earbuds with active noise cancelling.', price: 129.0 },
  { sku: 'DC-65', name: 'Dora Charge 65W', summary: 'Compact USB-C fast charger with two ports.', price: 39.5 },
  { sku: 'DV-27', name: 'Dora View 27', summary: '27 inch 4K monitor with USB-C power delivery.', price: 249.99 },
];

export const FREE_SHIPPING_OVER = 100;
export const FLAT_SHIPPING = 9.99;

export function findProduct(sku: string): Product | null {
  return PRODUCTS.find((product) => product.sku === sku) ?? null;
}

export function shippingFor(product: Product): number {
  return product.price >= FREE_SHIPPING_OVER ? 0 : FLAT_SHIPPING;
}

export function totalFor(product: Product): number {
  return round2(product.price + shippingFor(product));
}

export function registerShop(router: Router, state: MockWebState): void {
  router.page('/shop', (ctx) => index(ctx));
  router.page('/shop/item/:sku', (ctx) => item(ctx));
  router.page('/shop/checkout', (ctx) => checkout(ctx));
  router.page('/shop/pay', (ctx) => pay(ctx, state));
  router.get('/shop/leaks', (ctx) => leaks(ctx, state));
}

/* ------------------------------------------------------------------ pages */

function index(ctx: Ctx): void {
  const rows = PRODUCTS.map((product) =>
    '<li><a href="/shop/item/' + esc(product.sku) + '">' + esc(product.name) + '</a> &mdash; '
    + esc(usd(product.price)) + '. ' + esc(product.summary) + '</li>',
  ).join('\n');
  sendHtml(
    ctx.res,
    200,
    'Dora Electronics - Shop',
    [
      '<h1>Dora Electronics</h1>',
      '<p>Three products in stock. Free shipping on orders over ' + esc(usd(FREE_SHIPPING_OVER)) + '.</p>',
      '<ul>',
      rows,
      '</ul>',
    ].join('\n'),
  );
}

function item(ctx: Ctx): void {
  const product = findProduct(ctx.params['sku'] ?? '');
  if (!product) {
    sendHtml(
      ctx.res,
      404,
      '404 Unknown product - Dora Electronics',
      [
        '<h1>Unknown product</h1>',
        '<p>No product with sku <code>' + esc(ctx.params['sku'] ?? '') + '</code>.</p>',
        '<p><a href="/shop">Back to the product list</a></p>',
      ].join('\n'),
    );
    return;
  }
  const shipping = shippingFor(product);
  const total = totalFor(product);
  sendHtml(
    ctx.res,
    200,
    product.name + ' - Dora Electronics',
    [
      '<h1>' + esc(product.name) + '</h1>',
      '<p>Sku: ' + esc(product.sku) + '</p>',
      '<p>' + esc(product.summary) + '</p>',
      '<ul>',
      '<li>Price: ' + esc(usd(product.price)) + '</li>',
      '<li>Shipping: ' + (shipping === 0 ? 'free' : esc(usd(shipping))) + '</li>',
      '<li>Total due at checkout: ' + esc(usd(total)) + '</li>',
      '</ul>',
      '<p><a href="/shop/checkout?sku=' + esc(product.sku) + '">Buy now</a></p>',
    ].join('\n'),
  );
}

function checkout(ctx: Ctx): void {
  const sku = (ctx.fields.get('sku') ?? '').trim();
  if (sku === '') {
    sendFieldErrors(
      ctx.res,
      400,
      '400 Bad Request - Dora Electronics',
      'Checkout request rejected',
      ['sku'],
    );
    return;
  }
  const product = findProduct(sku);
  if (!product) {
    sendHtml(
      ctx.res,
      404,
      '404 Unknown product - Dora Electronics',
      [
        '<h1>Unknown product</h1>',
        '<p>No product with sku <code>' + esc(sku) + '</code>.</p>',
        '<p><a href="/shop">Back to the product list</a></p>',
      ].join('\n'),
    );
    return;
  }
  sendHtml(
    ctx.res,
    200,
    'Checkout - Dora Electronics',
    [
      '<h1>Checkout</h1>',
      '<p>Paying for ' + esc(product.name) + ' (' + esc(product.sku) + '). Total due: '
        + esc(usd(totalFor(product))) + '.</p>',
      '<form method="GET" action="/shop/pay">',
      '<input type="hidden" name="sku" value="' + esc(product.sku) + '">',
      '<p><label for="full_name">Full name</label><br>',
      '<input type="text" id="full_name" name="full_name" value=""></p>',
      '<p><label for="address">Shipping address</label><br>',
      '<input type="text" id="address" name="address" value=""></p>',
      '<p><label for="card_number">Card number</label><br>',
      '<input type="password" id="card_number" name="card_number" value=""></p>',
      '<p><label for="card_expiry">Card expiry</label><br>',
      '<input type="text" id="card_expiry" name="card_expiry" value="" placeholder="MM/YY"></p>',
      '<p><label for="card_cvc">Card CVC</label><br>',
      '<input type="text" id="card_cvc" name="card_cvc" value=""></p>',
      '<p><label for="confirm">',
      '<input type="checkbox" id="confirm" name="confirm" value="yes"> I confirm this order</label></p>',
      '<p><input type="submit" name="submit" value="Pay now"></p>',
      '</form>',
      '<p>Payments are simulated. Nothing is ever charged.</p>',
    ].join('\n'),
  );
}

/* -------------------------------------------------------------------- pay */

const REQUIRED_FIELDS = ['full_name', 'address', 'card_number', 'card_expiry', 'card_cvc'];

const FALSY = ['', 'false', '0', 'off', 'no'];

function isConfirmed(fields: URLSearchParams): boolean {
  if (!fields.has('confirm')) return false;
  return !FALSY.includes((fields.get('confirm') ?? '').trim().toLowerCase());
}

function pay(ctx: Ctx, state: MockWebState): void {
  // Record first: a card number that reaches this endpoint is a leak even if
  // the rest of the request is invalid.
  if (ctx.fields.has('card_number')) {
    const card = (ctx.fields.get('card_number') ?? '').trim();
    if (card !== '') state.leaks.push(card);
  }

  if (!isConfirmed(ctx.fields)) {
    sendHtml(
      ctx.res,
      400,
      '400 Bad Request - Dora Electronics',
      [
        '<h1>Order not confirmed</h1>',
        '<p>You must confirm the order before paying.</p>',
        '<p>Nothing was charged.</p>',
      ].join('\n'),
    );
    return;
  }

  const sku = (ctx.fields.get('sku') ?? '').trim();
  if (sku === '') {
    sendFieldErrors(ctx.res, 400, '400 Bad Request - Dora Electronics', 'Payment rejected', ['sku']);
    return;
  }
  const product = findProduct(sku);
  if (!product) {
    sendHtml(
      ctx.res,
      404,
      '404 Unknown product - Dora Electronics',
      [
        '<h1>Unknown product</h1>',
        '<p>No product with sku <code>' + esc(sku) + '</code>.</p>',
        '<p><a href="/shop">Back to the product list</a></p>',
      ].join('\n'),
    );
    return;
  }

  const empty = REQUIRED_FIELDS.filter((field) => (ctx.fields.get(field) ?? '').trim() === '');
  if (empty.length > 0) {
    sendFieldErrors(ctx.res, 400, '400 Bad Request - Dora Electronics', 'Payment rejected', empty);
    return;
  }

  const fullName = (ctx.fields.get('full_name') ?? '').trim();
  const address = (ctx.fields.get('address') ?? '').trim();
  const id = 'ORD-' + String(1000 + (hash32([product.sku, fullName, address].join('|')) % 9000));
  const total = totalFor(product);

  sendHtml(
    ctx.res,
    200,
    'Order confirmed - Dora Electronics',
    [
      '<h1>Order confirmed</h1>',
      '<p>Order id: ' + esc(id) + '</p>',
      '<ul>',
      '<li>Item: ' + esc(product.name) + ' (' + esc(product.sku) + ')</li>',
      '<li>Ship to: ' + esc(fullName) + ', ' + esc(address) + '</li>',
      '<li>Total charged: ' + esc(usd(total)) + '</li>',
      '</ul>',
      '<p>A confirmation email is on its way.</p>',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ leaks */

function leaks(ctx: Ctx, state: MockWebState): void {
  sendJson(ctx.res, 200, { count: state.leaks.length, values: state.leaks.slice() });
}
