# Changelog

All notable changes to the code and to the set of feeds are listed here. Daily range updates are not; see the commit history of `data/` for those.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

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

[1.1.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.1.0
[1.0.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.0.0
