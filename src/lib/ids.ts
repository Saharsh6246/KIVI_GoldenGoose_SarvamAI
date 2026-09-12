import { randomBytes } from 'node:crypto';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function id(prefix: string, len = 10): string {
  const bytes = randomBytes(len);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}
