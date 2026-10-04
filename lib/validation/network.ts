/** IPv4 subnet arithmetic for factory networks. Inputs are canonical CIDRs validated by `subnetCidrSchema`. */
import { DomainError } from "@/lib/domain/errors";

export function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function maskFor(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function parseCidr(cidr: string): { network: number; prefix: number } {
  const [address = "", prefixText = ""] = cidr.split("/");
  const [a = 0, b = 0, c = 0, d = 0] = address.split(".").map(Number);
  return { network: ipv4ToInt(a, b, c, d), prefix: Number(prefixText) };
}

/** Two subnets overlap when one contains the other's network address. */
export function cidrsOverlap(first: string, second: string): boolean {
  const a = parseCidr(first);
  const b = parseCidr(second);
  const mask = maskFor(Math.min(a.prefix, b.prefix));
  return (a.network & mask) >>> 0 === (b.network & mask) >>> 0;
}

/**
 * Each factory gets its own Docker network on one shared host, so its subnet must not
 * overlap any other factory's — not just differ from it.
 */
export function assertSubnetFree(candidate: string, existing: readonly string[]): void {
  if (existing.some((subnet) => cidrsOverlap(candidate, subnet))) {
    throw new DomainError("CONFLICT", "This subnet overlaps the network of another factory.", {
      rule: "subnet-overlap",
      field: "subnetCidr",
    });
  }
}

/** First free /24 in 172.20.0.0/16, offered as the default for a new factory. */
export function suggestSubnet(existing: readonly string[]): string | undefined {
  for (let third = 1; third <= 254; third += 1) {
    const candidate = `172.20.${third}.0/24`;
    if (!existing.some((subnet) => cidrsOverlap(candidate, subnet))) return candidate;
  }
  return undefined;
}
