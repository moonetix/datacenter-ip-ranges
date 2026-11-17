"""Datacenter, Tor, privacy relay and crawler IP lookup for Python 3.8+.

Standard library only. Copy this file next to a copy of data/ (or point
data_dir at one) and import it:

    from datacenter_ip import is_datacenter_ip, lookup, verify_bot

    is_datacenter_ip("3.5.140.1")      # True (AWS)
    lookup("185.220.101.1")            # [{"provider": "tor", "category": "tor"}]
    verify_bot("Mozilla/5.0 (compatible; GPTBot/1.2)", "132.196.86.5")

Command line: python3 datacenter_ip.py <ip> [ip ...]   (or "-" to read stdin)
"""

import bisect
import ipaddress
import json
import os
import sys

__all__ = [
    "BOTS", "DATACENTER_CATEGORIES", "Matcher", "load", "is_datacenter_ip",
    "lookup", "claimed_bot", "verify_bot", "parse_address",
]

DEFAULT_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DATACENTER_CATEGORIES = ("cloud", "cdn", "services")

# Crawlers whose operators publish the addresses they crawl from. Same table
# as src/bots.js; a test fails if they drift apart.
BOTS = [
    {"id": "google", "name": "Google",
     "tokens": ["Googlebot", "Storebot-Google", "Google-InspectionTool", "GoogleOther", "Google-CloudVertexBot", "AdsBot-Google", "Mediapartners-Google", "APIs-Google", "FeedFetcher-Google", "Google-Read-Aloud", "Google-Site-Verification", "GoogleProducer", "Google-Safety"],
     "providers": ["googlebot", "google-special-crawlers", "google-user-fetchers", "google-user-fetchers-google"]},
    {"id": "bing", "name": "Bing",
     "tokens": ["bingbot", "adidxbot", "BingPreview", "MicrosoftPreview"],
     "providers": ["bingbot"]},
    {"id": "applebot", "name": "Applebot",
     "tokens": ["Applebot"],
     "providers": ["applebot"]},
    {"id": "duckduckbot", "name": "DuckDuckBot",
     "tokens": ["DuckDuckBot"],
     "providers": ["duckduckbot"]},
    {"id": "gptbot", "name": "OpenAI GPTBot",
     "tokens": ["GPTBot"],
     "providers": ["gptbot"]},
    {"id": "oai-searchbot", "name": "OpenAI OAI-SearchBot",
     "tokens": ["OAI-SearchBot"],
     "providers": ["oai-searchbot"]},
    {"id": "chatgpt-user", "name": "OpenAI ChatGPT-User",
     "tokens": ["ChatGPT-User"],
     "providers": ["chatgpt-user"]},
    {"id": "perplexitybot", "name": "PerplexityBot",
     "tokens": ["PerplexityBot"],
     "providers": ["perplexitybot"]},
    {"id": "perplexity-user", "name": "Perplexity-User",
     "tokens": ["Perplexity-User"],
     "providers": ["perplexity-user"]},
    {"id": "mistralai-user", "name": "MistralAI-User",
     "tokens": ["MistralAI-User"],
     "providers": ["mistralai-user"]},
    {"id": "ccbot", "name": "Common Crawl CCBot",
     "tokens": ["CCBot"],
     "providers": ["ccbot"]},
    {"id": "ahrefsbot", "name": "Ahrefs",
     "tokens": ["AhrefsBot", "AhrefsSiteAudit"],
     "providers": ["ahrefsbot"]},
]


def parse_address(ip):
    """Return (4, int) or (6, int) for an address as it may arrive from a
    socket or a header ("1.2.3.4", "[2001:db8::1]", "fe80::1%eth0",
    "::ffff:1.2.3.4"), or None if it is not an IP address."""
    if not isinstance(ip, str):
        return None
    s = ip.strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    if "%" in s:
        s = s.split("%", 1)[0]
    if not s or "/" in s:
        return None
    try:
        a = ipaddress.ip_address(s)
    except ValueError:
        return None
    if a.version == 6 and a.ipv4_mapped is not None:
        return 4, int(a.ipv4_mapped)
    return a.version, int(a)


def _parse_cidr(text):
    net = ipaddress.ip_network(text.strip(), strict=False)
    return net.version, int(net.network_address), int(net.broadcast_address)


def _merge(ranges):
    out = []
    for start, end in sorted(ranges):
        if out and start <= out[-1][1] + 1:
            if end > out[-1][1]:
                out[-1][1] = end
        else:
            out.append([start, end])
    return [tuple(r) for r in out]


class Matcher:
    """Answers which lists contain an address. lists: [(id, category, [cidr, ...])]."""

    def __init__(self, lists):
        self._lists = []
        for list_id, category, cidrs in lists:
            fam = {4: [], 6: []}
            for c in cidrs:
                version, start, end = _parse_cidr(c)
                fam[version].append((start, end))
            tables = {}
            for version, ranges in fam.items():
                merged = _merge(ranges)
                tables[version] = ([r[0] for r in merged], [r[1] for r in merged])
            self._lists.append(({"provider": list_id, "category": category}, tables))

    @staticmethod
    def _hit(table, value):
        starts, ends = table
        i = bisect.bisect_right(starts, value) - 1
        return i >= 0 and value <= ends[i]

    def lookup(self, ip):
        """Every list that contains the address, [] if none, None for invalid input."""
        a = parse_address(ip)
        if a is None:
            return None
        version, value = a
        return [dict(meta) for meta, tables in self._lists if self._hit(tables[version], value)]

    def contains(self, ip):
        found = self.lookup(ip)
        return bool(found)


def _read_list(path):
    with open(path, encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]


def load(data_dir=None, categories=DATACENTER_CATEGORIES, providers=None):
    """Build a Matcher from data/sources.json and data/providers/."""
    data_dir = data_dir or DEFAULT_DATA_DIR
    with open(os.path.join(data_dir, "sources.json"), encoding="utf-8") as f:
        meta = json.load(f)
    lists = []
    for src in meta["sources"]:
        if not src.get("file"):
            continue
        if providers is not None:
            if src["id"] not in providers:
                continue
        elif src["category"] not in categories:
            continue
        path = os.path.join(data_dir, src["file"])
        if os.path.exists(path):
            lists.append((src["id"], src["category"], _read_list(path)))
    return Matcher(lists)


_cache = {}


def _cached(key, build):
    if key not in _cache:
        _cache[key] = build()
    return _cache[key]


def is_datacenter_ip(ip, data_dir=None):
    """True for cloud, hosting, CDN and provider-service ranges. Tor exits,
    iCloud Private Relay and crawlers are not included; use lookup() for those."""
    return _cached(("dc", data_dir), lambda: load(data_dir)).contains(ip)


def lookup(ip, data_dir=None):
    """Every list in every category that contains the address."""
    def build():
        with open(os.path.join(data_dir or DEFAULT_DATA_DIR, "sources.json"), encoding="utf-8") as f:
            categories = list(json.load(f)["categories"])
        return load(data_dir, categories=categories)
    return _cached(("all", data_dir), build).lookup(ip)


def claimed_bot(user_agent):
    """The BOTS entry a user-agent string claims to be, or None."""
    if not isinstance(user_agent, str) or not user_agent:
        return None
    ua = user_agent.lower()
    for bot in BOTS:
        if any(t.lower() in ua for t in bot["tokens"]):
            return bot
    return None


def verify_bot(user_agent, ip, data_dir=None):
    """None if the user agent claims no known crawler, otherwise a dict with
    bot, name, verified and provider. verified False means the address is not
    in the ranges the crawler's operator publishes."""
    bot = claimed_bot(user_agent)
    if bot is None:
        return None
    matcher = _cached(("crawler", data_dir), lambda: load(data_dir, categories=("crawler",)))
    hit = next((m for m in (matcher.lookup(ip) or []) if m["provider"] in bot["providers"]), None)
    return {"bot": bot["id"], "name": bot["name"], "verified": hit is not None,
            "provider": hit["provider"] if hit else None}


def _main(argv):
    ips = argv[1:]
    if ips == ["-"]:
        ips = sys.stdin.read().split()
    if not ips:
        sys.stderr.write("Usage: python3 datacenter_ip.py <ip> [ip ...]\n")
        return 2
    listed = invalid = False
    for ip in ips:
        found = lookup(ip)
        if found is None:
            invalid = True
            print(ip, "invalid")
        elif not found:
            print(ip, "not listed")
        else:
            listed = True
            print(ip, " ".join("%s:%s" % (m["provider"], m["category"]) for m in found))
    return 2 if invalid else 0 if listed else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
