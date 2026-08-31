import { isIP } from 'node:net';

interface Ipv4Range {
  readonly network: number;
  readonly mask: number;
}

interface Ipv6Range {
  readonly words: readonly number[];
  readonly wholeWords: number;
  readonly finalMask: number;
}

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) {
    return null;
  }
  return (
    ((numbers[0] as number) * 0x1000000 +
      (numbers[1] as number) * 0x10000 +
      (numbers[2] as number) * 0x100 +
      (numbers[3] as number)) >>>
    0
  );
}

function parseIpv6(address: string): readonly number[] | null {
  if (address.includes('%')) {
    return null;
  }
  const ipv4Separator = address.lastIndexOf(':');
  let normalized = address;
  if (address.includes('.') && ipv4Separator >= 0) {
    const ipv4 = parseIpv4(address.slice(ipv4Separator + 1));
    if (ipv4 === null) {
      return null;
    }
    normalized = `${address.slice(0, ipv4Separator)}:${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parseHalf = (half: string | undefined): readonly number[] | null => {
    if (half === undefined || half.length === 0) {
      return [];
    }
    const pieces = half.split(':');
    if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/u.test(piece))) {
      return null;
    }
    return pieces.map((piece) => Number.parseInt(piece, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1]);
  if (left === null || right === null) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv4Range(network: string, prefixLength: number): Ipv4Range {
  const value = parseIpv4(network);
  if (value === null) {
    throw new Error('invalid internal IPv4 address policy.');
  }
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return Object.freeze({ network: value & mask, mask });
}

function ipv6Range(network: string, prefixLength: number): Ipv6Range {
  const words = parseIpv6(network);
  if (words === null) {
    throw new Error('invalid internal IPv6 address policy.');
  }
  const remainder = prefixLength % 16;
  return Object.freeze({
    words: Object.freeze(words),
    wholeWords: Math.floor(prefixLength / 16),
    finalMask: remainder === 0 ? 0 : (0xffff << (16 - remainder)) & 0xffff,
  });
}

const SPECIAL_IPV4_RANGES: readonly Ipv4Range[] = Object.freeze([
  ipv4Range('0.0.0.0', 8),
  ipv4Range('10.0.0.0', 8),
  ipv4Range('100.64.0.0', 10),
  ipv4Range('127.0.0.0', 8),
  ipv4Range('169.254.0.0', 16),
  ipv4Range('172.16.0.0', 12),
  ipv4Range('192.0.0.0', 24),
  ipv4Range('192.0.2.0', 24),
  ipv4Range('192.31.196.0', 24),
  ipv4Range('192.52.193.0', 24),
  ipv4Range('192.88.99.0', 24),
  ipv4Range('192.168.0.0', 16),
  ipv4Range('192.175.48.0', 24),
  ipv4Range('198.18.0.0', 15),
  ipv4Range('198.51.100.0', 24),
  ipv4Range('203.0.113.0', 24),
  ipv4Range('224.0.0.0', 4),
  ipv4Range('240.0.0.0', 4),
]);

const GLOBAL_IPV6_RANGES: readonly Ipv6Range[] = Object.freeze([ipv6Range('2000::', 3)]);

const SPECIAL_IPV6_RANGES: readonly Ipv6Range[] = Object.freeze([
  ipv6Range('::', 96),
  ipv6Range('::ffff:0:0', 96),
  ipv6Range('64:ff9b::', 96),
  ipv6Range('64:ff9b:1::', 48),
  ipv6Range('100::', 64),
  ipv6Range('100:0:0:1::', 64),
  ipv6Range('2001::', 23),
  ipv6Range('2001:db8::', 32),
  ipv6Range('2002::', 16),
  ipv6Range('2620:4f:8000::', 48),
  ipv6Range('3ffe::', 16),
  ipv6Range('3fff::', 20),
  ipv6Range('5f00::', 16),
  ipv6Range('fc00::', 7),
  ipv6Range('fe80::', 10),
  ipv6Range('fec0::', 10),
  ipv6Range('ff00::', 8),
]);

function matchesIpv6(words: readonly number[], range: Ipv6Range): boolean {
  for (let index = 0; index < range.wholeWords; index += 1) {
    if (words[index] !== range.words[index]) {
      return false;
    }
  }
  if (range.finalMask === 0) {
    return true;
  }
  return (
    ((words[range.wholeWords] as number) & range.finalMask) ===
    ((range.words[range.wholeWords] as number) & range.finalMask)
  );
}

export function normalizeIpAddress(address: string): string {
  return address
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
}

export function isGlobalRoutableAddress(normalizedAddress: string): boolean {
  const family = isIP(normalizedAddress);
  if (family === 4) {
    const value = parseIpv4(normalizedAddress);
    return (
      value !== null && !SPECIAL_IPV4_RANGES.some((range) => (value & range.mask) === range.network)
    );
  }
  if (family !== 6) {
    return false;
  }
  const words = parseIpv6(normalizedAddress);
  return (
    words !== null &&
    GLOBAL_IPV6_RANGES.some((range) => matchesIpv6(words, range)) &&
    !SPECIAL_IPV6_RANGES.some((range) => matchesIpv6(words, range))
  );
}
