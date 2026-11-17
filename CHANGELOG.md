# Changelog

All notable changes to the code and to the set of feeds are listed here. Daily range updates are not; see the commit history of `data/` for those.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-17

### Added

- A `crawler` category with 15 feeds that crawler operators publish for verification: Google (common crawlers, special-case crawlers, user-triggered fetchers), Bingbot, Applebot, DuckDuckBot, OpenAI GPTBot, OAI-SearchBot and ChatGPT-User, PerplexityBot and Perplexity-User, MistralAI-User, Common Crawl CCBot and AhrefsBot. The category is kept out of `all.txt` and `isDatacenterIp()`.
- `verifyBot(userAgent, ip)` in Node.js, `verify_bot()` / `DatacenterIp::verifyBot()` in PHP and `verify_bot()` in Python: tells whether a request that claims to be a known crawler comes from the addresses its operator publishes. `BOTS` and `claimedBot()` expose the table of user-agent tokens and lists.
- `data/firewall/`: the datacenter list and the Tor exits as nftables sets (`*.nft`) and ipset restore files (`*.ipset`), rebuilt with the lists.
- A Python helper, `python/datacenter_ip.py`: standard library only, Python 3.8+, with `is_datacenter_ip()`, `lookup()`, `load()`, `verify_bot()` and a command line. Its tests and a Node/Python cross-check run with `npm test`.
- TypeScript declarations (`src/index.d.ts`).
- The npm package `datacenter-ip-ranges` and the Composer package `moonetix/datacenter-ip-ranges`.
- The lookup page shows published crawler ranges as their own verdict and carries schema.org Dataset markup.

### Changed

- Google's crawler lists are read from their current location under `developers.google.com/static/crawling/ipranges/`.
- The Google Cloud, Google services and crawler feeds share one parser for the `{ prefixes: [...] }` format.

## [1.2.0] - 2026-11-17

### Added

- A lookup page at https://moonetix.github.io/datacenter-ip-ranges/, built from the published lists and deployed to GitHub Pages: check one address or a whole list in the browser, see which provider range matched, and copy usage snippets. The build checks every verdict the page shows against the Node.js library.
- Issue chooser links to the lookup page and to private vulnerability reports.

### Changed

- Every GitHub Action in the workflows is pinned to a commit SHA, and each job has a timeout. Dependabot keeps the pins current.
- README: a shorter, general section on why datacenter traffic matters, and a shorter reading list.

### Fixed

- `bin/check.js` no longer cuts off its output when piped: it sets the exit code instead of calling `process.exit()` before stdout is flushed.

## [1.1.0] - 2026-11-12

### Added

- `scripts/feed-health.mjs`: after each daily update, lists the feeds that kept old data on two runs in a row and keeps one "Range update" issue open, updated or closed to match.
- `scripts/github-issue.mjs`: opens, updates and closes one issue per automation topic, labeled `automation`. Prints what it would do when no token is set.
- The update workflow opens the same issue when a run fails, with a link to the run.

### Changed

- The update workflow runs with read-only default permissions. Only the update job gets `contents: write` and `issues: write`.
- A rejected push in the update workflow is retried once after a rebase.
- `scripts/update.js` prints its usage and exits with code 2 on an unknown argument instead of throwing.

### Fixed

- README: Cloudflare WARP traffic exits from addresses outside Cloudflare's published ranges, so the `cdn` category does not match WARP users. The previous text said it did.

## [1.0.0] - 2026-11-11

### Added

- Feeds: AWS, Google Cloud, Google services, Oracle Cloud, DigitalOcean, Akamai Cloud (Linode), Vultr, Cloudflare, Fastly, GitHub, iCloud Private Relay, Tor exit nodes.
- Microsoft Azure Service Tags as an opt-in source for local builds (`--include azure`), not redistributed.
- `data/all.txt`, `ipv4.txt`, `ipv6.txt`, per provider and per category lists, `ranges.json`, `ranges.csv`, `sources.json`, `SOURCES.md`.
- Per feed fallback to the previous list when a feed fails or shrinks by more than half.
- Node.js helpers `isDatacenterIp()`, `lookup()`, `load()` and `createMatcher()`.
- PHP helper `DatacenterIp` and `is_datacenter_ip()`, with OPcache-friendly export.
- Command line checks `bin/check.js` and `php/check.php`.
- Daily update workflow and CI workflow.

[1.3.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.3.0
[1.2.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.2.0
[1.1.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.1.0
[1.0.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.0.0
