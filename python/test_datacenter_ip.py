"""Run: python3 python/test_datacenter_ip.py"""

import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import datacenter_ip as d  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class ParseAddress(unittest.TestCase):
    def test_accepts_socket_and_header_forms(self):
        self.assertEqual(d.parse_address("1.2.3.4"), (4, 0x01020304))
        self.assertEqual(d.parse_address(" 8.8.8.8 "), (4, 0x08080808))
        self.assertEqual(d.parse_address("::ffff:1.2.3.4"), (4, 0x01020304))
        self.assertEqual(d.parse_address("[2001:db8::1]"), (6, 0x20010DB8000000000000000000000001))
        self.assertEqual(d.parse_address("fe80::1%eth0"), (6, 0xFE800000000000000000000000000001))

    def test_rejects_everything_else(self):
        for bad in ["", "abc", "1.2.3", "256.1.1.1", "1.2.3.4/24", "1.2.3.4:443", "2001:db8::1::1", None, 42]:
            self.assertIsNone(d.parse_address(bad), repr(bad))


class MatcherTest(unittest.TestCase):
    def setUp(self):
        self.m = d.Matcher([
            ("a", "cloud", ["10.0.0.0/8", "10.1.0.0/16", "192.0.2.77/24", "2001:db8::/32"]),
            ("b", "tor", ["10.5.0.0/16", "198.51.100.7/32"]),
        ])

    def test_boundaries_and_overlaps(self):
        self.assertTrue(self.m.contains("10.0.0.0"))
        self.assertTrue(self.m.contains("10.255.255.255"))
        self.assertFalse(self.m.contains("11.0.0.0"))
        self.assertTrue(self.m.contains("192.0.2.0"))
        self.assertTrue(self.m.contains("2001:db8:ffff::1"))
        self.assertFalse(self.m.contains("2001:db9::"))
        self.assertTrue(self.m.contains("::ffff:10.2.3.4"))

    def test_lookup_returns_every_list(self):
        self.assertEqual(self.m.lookup("10.5.1.1"), [{"provider": "a", "category": "cloud"}, {"provider": "b", "category": "tor"}])
        self.assertEqual(self.m.lookup("198.51.100.8"), [])
        self.assertIsNone(self.m.lookup("nope"))


class RealData(unittest.TestCase):
    def test_well_known_addresses(self):
        self.assertTrue(d.is_datacenter_ip("104.16.0.1"))
        self.assertTrue(d.is_datacenter_ip("2606:4700::1"))
        for no in ["127.0.0.1", "10.1.2.3", "::1", "203.0.113.9", "not an ip"]:
            self.assertFalse(d.is_datacenter_ip(no), no)
        self.assertEqual(d.lookup("104.16.0.1"), [{"provider": "cloudflare", "category": "cdn"}])

    def test_verify_bot(self):
        self.assertIsNone(d.verify_bot("Mozilla/5.0 Firefox/130.0", "8.8.8.8"))
        fake = d.verify_bot("Mozilla/5.0 (compatible; Googlebot/2.1)", "192.0.2.1")
        self.assertEqual(fake, {"bot": "google", "name": "Google", "verified": False, "provider": None})

    def test_cli_exit_codes(self):
        run = lambda *a: subprocess.run([sys.executable, "-I", os.path.join(HERE, "datacenter_ip.py"), *a], capture_output=True, text=True)
        self.assertEqual(run("104.16.0.1").returncode, 0)
        self.assertEqual(run("192.168.1.1").returncode, 1)
        self.assertEqual(run("1.2.3").returncode, 2)
        self.assertEqual(run().returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
