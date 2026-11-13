import { formatAddress } from './lib/ip.js';

function decodeFamily(text, family) {
  if (!text) return [];
  const bits = family === 4 ? 32n : 128n;
  const prefixWidth = family === 4 ? 1 : 2;
  const radix = family === 4 ? 36 : 16;
  const out = [];
  let next = 0n;
  for (const token of text.split(',')) {
    const gapText = token.slice(0, token.length - prefixWidth);
    const prefix = parseInt(token.slice(token.length - prefixWidth), radix);
    const gap = gapText === '' ? 0n : family === 4 ? BigInt(parseInt(gapText, 36)) : BigInt('0x' + gapText);
    const start = next + gap;
    out.push(formatAddress(family, start) + '/' + prefix);
    next = start + (1n << (bits - BigInt(prefix)));
  }
  return out;
}

export function decodeProvider(p) {
  return decodeFamily(p.v4, 4).concat(decodeFamily(p.v6, 6));
}
