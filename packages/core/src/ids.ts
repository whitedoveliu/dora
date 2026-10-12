import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Time-sortable identifier (Crockford base32 ULID). */
export function ulid(prefix = ''): string {
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = ALPHABET[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ALPHABET[rand[i] % 32];
  const id = head + tail;
  return prefix ? prefix + '_' + id : id;
}

export function shortId(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

export function token(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
