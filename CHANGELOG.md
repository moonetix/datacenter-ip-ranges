# Changelog

All notable changes to the code and to the set of feeds are listed here. Daily range updates are not; see the commit history of `data/` for those.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/moonetix/datacenter-ip-ranges/releases/tag/v1.0.0
