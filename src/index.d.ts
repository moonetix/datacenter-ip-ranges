export type Category = 'cloud' | 'cdn' | 'services' | 'privacy-relay' | 'tor' | 'crawler';

export interface Match {
  provider: string;
  category: Category;
}

export interface Matcher {
  size: { ipv4Segments: number; ipv6Segments: number };
  /** True if the address is in any loaded list. Invalid input returns false. */
  contains(ip: string): boolean;
  /** Every loaded list that contains the address, [] if none, null if the input is not an IP address. */
  lookup(ip: string): Match[] | null;
}

export interface LoadOptions {
  /** Folder with sources.json and providers/. Default: the package's data/. */
  dataDir?: string;
  /** Categories to load. Default: cloud, cdn, services. */
  categories?: Category[];
  /** Provider IDs to load, instead of categories. */
  providers?: string[];
}

export interface Bot {
  id: string;
  name: string;
  /** User-agent tokens, matched case-insensitively anywhere in the string. */
  tokens: string[];
  /** Provider lists (category "crawler") the bot's requests must come from. */
  providers: string[];
}

export interface BotCheck {
  bot: string;
  name: string;
  /** True if the address is in the ranges the bot's operator publishes. */
  verified: boolean;
  /** The provider list that matched, or null. */
  provider: string | null;
}

/** True for cloud, hosting, CDN and provider-service ranges. Tor, Private Relay and crawlers are not included. */
export function isDatacenterIp(ip: string): boolean;
/** Every list in every category that contains the address. */
export function lookup(ip: string): Match[] | null;
/** null if the user agent claims no known crawler; otherwise whether the address belongs to that crawler. */
export function verifyBot(userAgent: string, ip: string, options?: { dataDir?: string }): BotCheck | null;
/** The bot a user-agent string claims to be, or null. */
export function claimedBot(userAgent: string): Bot | null;
export function load(options?: LoadOptions): Matcher;
export function createMatcher(lists: { id: string; category: string; cidrs: string[] }[]): Matcher;
export function readList(file: string): string[];
export const BOTS: Bot[];
export const DEFAULT_DATA_DIR: string;
