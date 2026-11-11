<?php

declare(strict_types=1);

// Usage: php php/check.php <ip> [ip ...]     or     ... | php php/check.php -
// Prints "<ip> listed" or "<ip> not listed" for the datacenter categories.
// Exit code 0 if any address is listed, 1 if none is, 2 on invalid input.

require __DIR__ . '/DatacenterIp.php';

$ips = array_slice($argv, 1);
if ($ips === ['-']) {
    $ips = preg_split('/\s+/', (string)stream_get_contents(STDIN), -1, PREG_SPLIT_NO_EMPTY);
}
if (!$ips) {
    fwrite(STDERR, "Usage: php php/check.php <ip> [ip ...]\n");
    exit(2);
}
$matcher = DatacenterIp::fromDataDir();
$listed = false;
$invalid = false;
foreach ($ips as $ip) {
    if (DatacenterIp::parseAddress($ip) === null) {
        $invalid = true;
        echo "$ip invalid\n";
        continue;
    }
    $hit = $matcher->contains($ip);
    $listed = $listed || $hit;
    echo $ip, $hit ? " listed\n" : " not listed\n";
}
exit($invalid ? 2 : ($listed ? 0 : 1));
