<?php

declare(strict_types=1);

/**
 * Datacenter IP lookup for PHP 8.1+. No extensions beyond the standard ones.
 *
 *   require 'php/DatacenterIp.php';
 *   if (is_datacenter_ip($_SERVER['REMOTE_ADDR'])) { ... }
 *
 * Ranges are merged and searched with a binary search, so a lookup is a few
 * string compares. Loading the lists parses a few thousand lines; in a busy
 * app, build once with exportPhp() and load with fromPhp() so OPcache keeps
 * the arrays in shared memory.
 */
final class DatacenterIp
{
    public const DATACENTER_CATEGORIES = ['cloud', 'cdn', 'services'];

    /** @param int[] $v4s @param int[] $v4e @param string[] $v6s @param string[] $v6e */
    private function __construct(
        private array $v4s,
        private array $v4e,
        private array $v6s,
        private array $v6e,
    ) {
    }

    /** Loads data/categories/<category>.txt for each category. */
    public static function fromDataDir(?string $dataDir = null, array $categories = self::DATACENTER_CATEGORIES): self
    {
        $dataDir ??= dirname(__DIR__) . '/data';
        $files = [];
        foreach ($categories as $c) {
            if (!preg_match('/^[a-z-]+$/', $c)) {
                throw new InvalidArgumentException("Invalid category: $c");
            }
            $files[] = "$dataDir/categories/$c.txt";
        }
        return self::fromFiles($files);
    }

    /** Loads one or more files with one CIDR per line. */
    public static function fromFiles(array $files): self
    {
        $cidrs = [];
        foreach ($files as $f) {
            $text = @file_get_contents($f);
            if ($text === false) {
                throw new RuntimeException("Cannot read $f");
            }
            foreach (preg_split('/\R/', $text) as $line) {
                $line = trim($line);
                if ($line !== '' && $line[0] !== '#') {
                    $cidrs[] = $line;
                }
            }
        }
        return self::fromCidrs($cidrs);
    }

    /** @param string[] $cidrs */
    public static function fromCidrs(array $cidrs): self
    {
        $v4 = [];
        $v6 = [];
        foreach ($cidrs as $cidr) {
            $r = self::parseCidr($cidr);
            if ($r === null) {
                throw new InvalidArgumentException("Invalid CIDR: $cidr");
            }
            if (is_int($r[0])) {
                $v4[] = $r;
            } else {
                $v6[] = $r;
            }
        }
        usort($v4, static fn(array $a, array $b): int => $a[0] <=> $b[0]);
        usort($v6, static fn(array $a, array $b): int => strcmp($a[0], $b[0]));
        [$v4s, $v4e] = self::merge($v4, static fn($a, $b): int => $a <=> $b);
        [$v6s, $v6e] = self::merge($v6, 'strcmp');
        return new self($v4s, $v4e, $v6s, $v6e);
    }

    /** Writes a PHP file that fromPhp() loads. OPcache keeps its arrays in memory. */
    public function exportPhp(string $file): void
    {
        $data = [
            'v4s' => $this->v4s,
            'v4e' => $this->v4e,
            'v6s' => array_map('bin2hex', $this->v6s),
            'v6e' => array_map('bin2hex', $this->v6e),
        ];
        $tmp = $file . '.' . getmypid() . '.tmp';
        file_put_contents($tmp, "<?php\nreturn " . var_export($data, true) . ";\n");
        rename($tmp, $file);
    }

    public static function fromPhp(string $file): self
    {
        $d = require $file;
        return new self($d['v4s'], $d['v4e'], array_map('hex2bin', $d['v6s']), array_map('hex2bin', $d['v6e']));
    }

    /** True if the address is in one of the loaded ranges. Invalid input returns false. */
    public function contains(string $ip): bool
    {
        $a = self::parseAddress($ip);
        if ($a === null) {
            return false;
        }
        if (is_int($a)) {
            $s = $this->v4s;
            $e = $this->v4e;
            $lo = 0;
            $hi = count($s) - 1;
            $hit = -1;
            while ($lo <= $hi) {
                $mid = ($lo + $hi) >> 1;
                if ($s[$mid] <= $a) {
                    $hit = $mid;
                    $lo = $mid + 1;
                } else {
                    $hi = $mid - 1;
                }
            }
            return $hit !== -1 && $a <= $e[$hit];
        }
        $s = $this->v6s;
        $e = $this->v6e;
        $lo = 0;
        $hi = count($s) - 1;
        $hit = -1;
        while ($lo <= $hi) {
            $mid = ($lo + $hi) >> 1;
            if (strcmp($s[$mid], $a) <= 0) {
                $hit = $mid;
                $lo = $mid + 1;
            } else {
                $hi = $mid - 1;
            }
        }
        return $hit !== -1 && strcmp($a, $e[$hit]) <= 0;
    }

    public function count(): int
    {
        return count($this->v4s) + count($this->v6s);
    }

    /**
     * Parses an address as it may arrive from a socket or a header:
     * "1.2.3.4", "2001:db8::1", "[2001:db8::1]", "fe80::1%eth0", "::ffff:1.2.3.4".
     * Returns an int for IPv4 (IPv4-mapped IPv6 included), a 16 byte string for IPv6, or null.
     */
    public static function parseAddress(string $ip): int|string|null
    {
        $ip = trim($ip);
        if (str_starts_with($ip, '[') && str_ends_with($ip, ']')) {
            $ip = substr($ip, 1, -1);
        }
        $zone = strpos($ip, '%');
        if ($zone !== false) {
            $ip = substr($ip, 0, $zone);
        }
        if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
            return null;
        }
        $bin = inet_pton($ip);
        if ($bin === false) {
            return null;
        }
        if (strlen($bin) === 16 && substr($bin, 0, 12) === "\0\0\0\0\0\0\0\0\0\0\xff\xff") {
            $bin = substr($bin, 12);
        }
        return strlen($bin) === 4 ? unpack('N', $bin)[1] : $bin;
    }

    /** @return array{0:int|string,1:int|string}|null start and end, host bits cleared */
    private static function parseCidr(string $cidr): ?array
    {
        $parts = explode('/', trim($cidr), 2);
        if (str_contains($parts[0], '%') || filter_var($parts[0], FILTER_VALIDATE_IP) === false) {
            return null;
        }
        $bin = inet_pton($parts[0]);
        $bits = strlen($bin) * 8;
        if (isset($parts[1])) {
            if (!preg_match('/^(0|[1-9][0-9]{0,2})$/', $parts[1]) || (int)$parts[1] > $bits) {
                return null;
            }
            $prefix = (int)$parts[1];
        } else {
            $prefix = $bits;
        }
        if ($bits === 32) {
            $n = unpack('N', $bin)[1];
            $size = 1 << (32 - $prefix);
            $start = intdiv($n, $size) * $size;
            return [$start, $start + $size - 1];
        }
        $start = '';
        $end = '';
        for ($i = 0; $i < 16; $i++) {
            $keep = max(0, min(8, $prefix - $i * 8));
            $mask = $keep === 0 ? 0 : (0xFF << (8 - $keep)) & 0xFF;
            $b = ord($bin[$i]);
            $start .= chr($b & $mask);
            $end .= chr(($b & $mask) | (~$mask & 0xFF));
        }
        return [$start, $end];
    }

    /** Merges sorted, possibly overlapping ranges. */
    private static function merge(array $ranges, callable $cmp): array
    {
        $s = [];
        $e = [];
        $n = -1;
        foreach ($ranges as [$rs, $re]) {
            if ($n >= 0 && $cmp($rs, $e[$n]) <= 0) {
                if ($cmp($re, $e[$n]) > 0) {
                    $e[$n] = $re;
                }
                continue;
            }
            $s[] = $rs;
            $e[] = $re;
            $n++;
        }
        return [$s, $e];
    }
}

/**
 * True if the address belongs to a cloud, hosting, CDN or provider-service range.
 * Tor exits and iCloud Private Relay are not included. The lists load once per process.
 */
function is_datacenter_ip(string $ip, ?string $dataDir = null): bool
{
    static $cache = [];
    $key = $dataDir ?? '';
    $cache[$key] ??= DatacenterIp::fromDataDir($dataDir);
    return $cache[$key]->contains($ip);
}
