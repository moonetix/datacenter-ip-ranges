<?php

declare(strict_types=1);

// Run: php php/test.php

require __DIR__ . '/DatacenterIp.php';

$pass = 0;
$fail = 0;
function check(bool $ok, string $name): void
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
        echo "ok    $name\n";
    } else {
        $fail++;
        echo "FAIL  $name\n";
    }
}

// Address parsing.
check(DatacenterIp::parseAddress('1.2.3.4') === 0x01020304, 'parses IPv4');
check(DatacenterIp::parseAddress('::ffff:1.2.3.4') === 0x01020304, 'maps IPv4-mapped IPv6 to IPv4');
check(DatacenterIp::parseAddress('[2001:db8::1]') === inet_pton('2001:db8::1'), 'strips brackets');
check(DatacenterIp::parseAddress('fe80::1%eth0') === inet_pton('fe80::1'), 'strips zone ID');
check(DatacenterIp::parseAddress(' 8.8.8.8 ') === 0x08080808, 'trims spaces');
foreach (['', 'abc', '1.2.3', '256.1.1.1', '1.2.3.4/24', '2001:db8::1::1', '1.2.3.4 5'] as $bad) {
    check(DatacenterIp::parseAddress($bad) === null, 'rejects ' . var_export($bad, true));
}

// Matching with a small list: boundaries, host bits, overlaps.
$m = DatacenterIp::fromCidrs([
    '10.0.0.0/8',
    '10.1.0.0/16',
    '192.0.2.77/24',
    '198.51.100.7',
    '2001:db8::/32',
    '2001:db8:1::/48',
    '2600:1f00::5/30',
]);
check($m->count() === 5, 'overlapping ranges are merged (' . $m->count() . ')');
check($m->contains('10.0.0.0') && $m->contains('10.255.255.255'), 'IPv4 range boundaries included');
check(!$m->contains('9.255.255.255') && !$m->contains('11.0.0.0'), 'IPv4 neighbors excluded');
check($m->contains('192.0.2.0') && $m->contains('192.0.2.255'), 'host bits in a CIDR are cleared');
check($m->contains('198.51.100.7') && !$m->contains('198.51.100.8'), 'bare address is a /32');
check($m->contains('2001:db8::') && $m->contains('2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'), 'IPv6 range boundaries included');
check(!$m->contains('2001:db7:ffff:ffff:ffff:ffff:ffff:ffff') && !$m->contains('2001:db9::'), 'IPv6 neighbors excluded');
check($m->contains('2600:1f03:ffff::1') && !$m->contains('2600:1f04::'), 'IPv6 /30 with host bits');
check($m->contains('::ffff:10.2.3.4'), 'IPv4-mapped address matches IPv4 list');
check(!$m->contains('not an ip'), 'invalid input is not listed');

// Export to a PHP file and load it back.
$tmp = tempnam(sys_get_temp_dir(), 'dcip');
$m->exportPhp($tmp);
$m2 = DatacenterIp::fromPhp($tmp);
unlink($tmp);
check($m2->contains('2001:db8::1') && $m2->contains('10.9.9.9') && !$m2->contains('11.0.0.1'), 'exportPhp and fromPhp round trip');

// The real data shipped in data/.
$t = microtime(true);
$real = DatacenterIp::fromDataDir();
$loadMs = (microtime(true) - $t) * 1000;
check($real->count() > 1000, sprintf('real data loads (%d ranges, %.0f ms)', $real->count(), $loadMs));
check(is_datacenter_ip('104.16.0.1') && is_datacenter_ip('2606:4700::1'), 'Cloudflare is listed');
check(is_datacenter_ip('8.8.8.8'), 'Google services is listed');
check(!is_datacenter_ip('192.168.1.1') && !is_datacenter_ip('127.0.0.1') && !is_datacenter_ip('::1'), 'private and loopback are not listed');
$relay = DatacenterIp::fromDataDir(null, ['privacy-relay']);
check($relay->count() > 0, 'privacy-relay category loads separately');
try {
    DatacenterIp::fromDataDir(null, ['../etc']);
    check(false, 'category names are validated');
} catch (InvalidArgumentException) {
    check(true, 'category names are validated');
}

$t = microtime(true);
for ($i = 0; $i < 100000; $i++) {
    $real->contains('34.' . ($i & 255) . '.' . (($i >> 8) & 255) . '.1');
}
check(true, sprintf('100k lookups in %.0f ms', (microtime(true) - $t) * 1000));

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
