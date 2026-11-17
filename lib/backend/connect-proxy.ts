// Task 7.2: Per-run container network isolation and egress CONNECT proxy
// Requirements: 21.9, 21.10, 21.11, 21.12, 43.8, 43.11

import * as http from "node:http";
import * as net from "node:net";
import * as dns from "node:dns";
import type * as stream from "node:stream";
import { URL } from "node:url";

/**
 * Egress allowlist confirmed by Phase 0 NE-01 and NE-02 evidence.
 * Requirements: 21.9, 21.10, 43.8.
 */
export const CONFIRMED_ALLOWED_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
] as const;

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = CONFIRMED_ALLOWED_HOSTS;
export const ALLOWED_EGRESS_HOSTS: readonly string[] = CONFIRMED_ALLOWED_HOSTS;
export const ALLOWED_HOSTS: readonly string[] = CONFIRMED_ALLOWED_HOSTS;

/**
 * Reasons cited per exact host name in accordance with NE-02.
 */
export const ALLOWED_HOST_REASONS: Readonly<Record<string, string>> = {
  "registry.npmjs.org": "npm package registry",
  "pypi.org": "PyPI package index",
  "files.pythonhosted.org": "Python package wheel and tarball distribution",
  "github.com": "GitHub repository clone and fetch",
  "codeload.github.com": "GitHub repository archive and tarball download",
};

/**
 * Hard-blocked cloud metadata addresses.
 * Requirements: 21.11, 43.8.
 */
export const CLOUD_METADATA_ADDRESS = "169.254.169.254" as const;
export const CLOUD_METADATA_IPS = [CLOUD_METADATA_ADDRESS] as const;

/**
 * Hard-blocked hosts and cloud metadata destinations.
 * Requirements: 21.11, 43.8, 43.11.
 */
export const DEFAULT_BLOCKED_HOSTS = [
  "api.github.com",
  "169.254.169.254",
] as const;

export const BLOCKED_HOSTS: readonly string[] = DEFAULT_BLOCKED_HOSTS;

export type EvaluationCode =
  | "ALLOWED"
  | "BLOCKED_METADATA"
  | "BLOCKED_PRIVATE_IP"
  | "BLOCKED_API_GITHUB"
  | "BLOCKED_KIRO_HOST"
  | "BLOCKED_EXPLICIT"
  | "BLOCKED_PORT"
  | "NOT_IN_ALLOWLIST";

/**
 * Ports accepted for CONNECT when the matched allowlist entry does not
 * restrict them. Audit item N-C8.
 */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [443, 80];

/**
 * Allowlist entry: a bare host name, or an object that optionally restricts
 * the ports accepted for CONNECT to that host.
 */
export type AllowedHostEntry =
  | string
  | { host: string; ports?: readonly number[] };

export interface HostEvaluationResult {
  readonly allowed: boolean;
  readonly code: EvaluationCode;
  readonly reason: string;
  readonly host: string;
  readonly port?: number;
}

export interface ConnectProxyOptions {
  allowedHosts?: readonly AllowedHostEntry[];
  blockedHosts?: readonly string[];
  kiroHosts?: readonly string[];
  port?: number;
  host?: string;
  lookupFn?: (
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: any,
      family?: number
    ) => void
  ) => void;
  allowPrivateIps?: boolean;
  onAllowed?: (dest: { host: string; port?: number }, req: http.IncomingMessage) => void;
  onBlocked?: (result: HostEvaluationResult, req: http.IncomingMessage) => void;
  onBlockedRequest?: (target: string, port: number, reason: string) => void;
}

/**
 * Match a host against one allowlist entry and report the entry's port
 * restriction, if any.
 */
function matchAllowedEntry(
  host: string,
  entry: AllowedHostEntry
): { matched: boolean; ports?: readonly number[] } {
  if (typeof entry === "string") {
    return { matched: entry.trim().toLowerCase() === host };
  }
  const entryHost = entry.host.trim().toLowerCase();
  return { matched: entryHost === host, ports: entry.ports };
}

let configuredKiroHosts: string[] = [];

/**
 * Configure Kiro host list recorded by probe P11.
 * Probe P11 provides the exact hosts once executed.
 * Requirement 21.11.
 */
export function setKiroHosts(hosts: readonly string[]): void {
  configuredKiroHosts = hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function getKiroHosts(): readonly string[] {
  return [...configuredKiroHosts];
}

export function clearKiroHosts(): void {
  configuredKiroHosts = [];
}

/**
 * Parse and normalize destination target into lower-case host and optional port.
 */
export function normalizeHost(target: string): { host: string; port?: number } {
  if (!target || typeof target !== "string") {
    return { host: "" };
  }
  const trimmed = target.trim().toLowerCase();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const u = new URL(trimmed);
      const portVal = u.port
        ? parseInt(u.port, 10)
        : u.protocol === "https:"
        ? 443
        : 80;
      return {
        host: u.hostname.replace(/\.$/, ""),
        port: isNaN(portVal) ? undefined : portVal,
      };
    } catch {
      // Fall through to manual parsing if URL constructor fails
    }
  }

  const ipv6Match = trimmed.match(/^\[([a-f0-9:]+)\](?::(\d+))?$/);
  if (ipv6Match) {
    const p = ipv6Match[2] ? parseInt(ipv6Match[2], 10) : undefined;
    return {
      host: ipv6Match[1],
      port: p && !isNaN(p) ? p : undefined,
    };
  }

  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex !== -1 && !trimmed.includes("/")) {
    if (colonIndex !== trimmed.indexOf(":") && !trimmed.startsWith("[")) {
      if (net.isIP(trimmed) === 6) {
        return { host: trimmed };
      }
    }
    const hostPart = trimmed.slice(0, colonIndex).replace(/\.$/, "");
    const portPart = trimmed.slice(colonIndex + 1);
    if (portPart.length > 0 && !/^\d+$/.test(portPart)) {
      return { host: "", port: NaN };
    }
    if (/^\d+$/.test(portPart)) {
      const parsedPort = parseInt(portPart, 10);
      return { host: hostPart, port: parsedPort };
    }
  }

  return { host: trimmed.replace(/\.$/, "") };
}

function parseIpv6(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null;
  const lastColon = ip.lastIndexOf(":");
  let baseIp = ip;
  let embeddedV4: number[] = [];
  if (lastColon !== -1) {
    const afterColon = ip.slice(lastColon + 1);
    if (afterColon.includes(".")) {
      const v4Parts = afterColon.split(".").map(Number);
      if (v4Parts.length === 4 && v4Parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
        embeddedV4 = [
          ((v4Parts[0] << 8) | v4Parts[1]) & 0xffff,
          ((v4Parts[2] << 8) | v4Parts[3]) & 0xffff,
        ];
        baseIp = ip.slice(0, lastColon);
      }
    }
  }

  const parts = baseIp.split("::");
  let groups: string[] = [];
  const targetLen = 8 - embeddedV4.length;
  if (parts.length === 1) {
    groups = parts[0].split(":");
  } else if (parts.length === 2) {
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const missing = targetLen - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    return null;
  }
  if (groups.length !== targetLen) return null;
  const parsedGroups = groups.map((g) => parseInt(g, 16));
  return [...parsedGroups, ...embeddedV4];
}

/**
 * Check if an IP address is private, reserved, metadata, or loopback.
 */
export function isPrivateOrReservedIp(ip: string): {
  blocked: boolean;
  isMetadata: boolean;
  isLoopback: boolean;
  reason?: string;
} {
  if (!ip || typeof ip !== "string") {
    return { blocked: false, isMetadata: false, isLoopback: false };
  }
  let clean = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  clean = clean.split("%")[0];

  const mappedMatch = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    clean = mappedMatch[1];
  } else {
    const hexMappedMatch = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMappedMatch) {
      const w1 = parseInt(hexMappedMatch[1], 16);
      const w2 = parseInt(hexMappedMatch[2], 16);
      clean = `${(w1 >> 8) & 0xff}.${w1 & 0xff}.${(w2 >> 8) & 0xff}.${w2 & 0xff}`;
    }
  }

  const ipVer = net.isIP(clean);
  if (ipVer === 4) {
    const parts = clean.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return { blocked: false, isMetadata: false, isLoopback: false };
    }
    const [o1, o2, o3, o4] = parts;

    // 169.254.0.0/16 (Link-Local / Cloud Metadata)
    if (o1 === 169 && o2 === 254) {
      return {
        blocked: true,
        isMetadata: true,
        isLoopback: false,
        reason: "Cloud metadata / link-local address (169.254.0.0/16)",
      };
    }

    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: true,
        reason: "Loopback address (127.0.0.0/8)",
      };
    }

    // 0.0.0.0/8 (Current network / default route)
    if (o1 === 0) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Current network / default route (0.0.0.0/8)",
      };
    }

    // 10.0.0.0/8 (Private network)
    if (o1 === 10) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Private network (10.0.0.0/8)",
      };
    }

    // 100.64.0.0/10 (Shared Address Space / CGNAT)
    if (o1 === 100 && o2 >= 64 && o2 <= 127) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Carrier-grade NAT (100.64.0.0/10)",
      };
    }

    // 172.16.0.0/12 (Private network)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Private network (172.16.0.0/12)",
      };
    }

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (o1 === 192 && o2 === 0 && o3 === 0) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "IETF protocol assignments (192.0.0.0/24)",
      };
    }

    // 192.168.0.0/16 (Private network)
    if (o1 === 192 && o2 === 168) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Private network (192.168.0.0/16)",
      };
    }

    // 198.18.0.0/15 (Benchmarking)
    if (o1 === 198 && (o2 === 18 || o2 === 19)) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Network benchmark tests (198.18.0.0/15)",
      };
    }

    // 224.0.0.0/4 (Multicast / Reserved 240.0.0.0/4)
    if (o1 >= 224) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "Multicast or reserved address (224.0.0.0/4)",
      };
    }

    return { blocked: false, isMetadata: false, isLoopback: false };
  }

  if (ipVer === 6) {
    const groups = parseIpv6(clean);
    if (!groups) {
      return { blocked: false, isMetadata: false, isLoopback: false };
    }

    // fd00:ec2::254 (AWS EC2 metadata service)
    if (
      groups[0] === 0xfd00 &&
      groups[1] === 0x0ec2 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0 &&
      groups[7] === 0x0254
    ) {
      return {
        blocked: true,
        isMetadata: true,
        isLoopback: false,
        reason: "AWS EC2 metadata address (fd00:ec2::254)",
      };
    }

    // fe80::a9fe:a9fe (Cloud metadata link-local)
    if (
      groups[0] === 0xfe80 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0xa9fe &&
      groups[7] === 0xa9fe
    ) {
      return {
        blocked: true,
        isMetadata: true,
        isLoopback: false,
        reason: "Cloud metadata address (fe80::a9fe:a9fe)",
      };
    }

    // ::1 (Loopback)
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0 &&
      groups[7] === 1
    ) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: true,
        reason: "IPv6 loopback address (::1)",
      };
    }

    // :: (Unspecified address)
    if (groups.every((g) => g === 0)) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "IPv6 unspecified address (::)",
      };
    }

    // fe80::/10 (Link-local unicast)
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "IPv6 link-local address (fe80::/10)",
      };
    }

    // fc00::/7 (Unique local address / ULA)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "IPv6 unique local address (fc00::/7)",
      };
    }

    // ff00::/8 (Multicast)
    if ((groups[0] & 0xff00) === 0xff00) {
      return {
        blocked: true,
        isMetadata: false,
        isLoopback: false,
        reason: "IPv6 multicast address (ff00::/8)",
      };
    }

    return { blocked: false, isMetadata: false, isLoopback: false };
  }

  return { blocked: false, isMetadata: false, isLoopback: false };
}

/**
 * Check if a host represents cloud metadata endpoints.
 * Requirements: 21.11.
 */
export function isCloudMetadata(host: string): boolean {
  const norm = host.trim().toLowerCase();
  if (!norm) return false;
  if (norm === "169.254.169.254") return true;
  if (norm.startsWith("169.254.")) return true;
  if (norm === "instance-data" || norm === "metadata.google.internal") return true;
  if (norm === "fd00:ec2::254") return true;
  if (isPrivateOrReservedIp(norm).isMetadata) return true;
  return false;
}

/**
 * Match a host against the Kiro host list.
 * Requirements: 21.11.
 */
export function isKiroHost(host: string, kiroHosts: readonly string[]): boolean {
  const norm = host.trim().toLowerCase();
  if (!norm) return false;
  for (const pattern of kiroHosts) {
    const p = pattern.trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      if (norm === suffix || norm.endsWith("." + suffix)) {
        return true;
      }
    } else {
      if (norm === p || norm.endsWith("." + p)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Evaluate destination target against allowlist and blocklist policies.
 * Requirements: 21.9, 21.10, 21.11, 43.8.
 */
export function evaluateHost(
  target: string,
  options?: ConnectProxyOptions
): HostEvaluationResult {
  const { host, port } = normalizeHost(target);

  if (!host) {
    return {
      allowed: false,
      code: "NOT_IN_ALLOWLIST",
      reason: "Empty or invalid host",
      host: "",
      port,
    };
  }

  const strippedHost = host.replace(/^\[|\]$/g, "").split("%")[0];

  if (net.isIP(strippedHost) !== 0) {
    const ipCheck = isPrivateOrReservedIp(strippedHost);
    if (ipCheck.isMetadata) {
      return {
        allowed: false,
        code: "BLOCKED_METADATA",
        reason: ipCheck.reason ?? `Cloud metadata address (${strippedHost}) is forbidden`,
        host,
        port,
      };
    }

    if (ipCheck.isLoopback) {
      const isLoopbackAllowed =
        options?.allowPrivateIps === true ||
        Boolean(
          options?.allowedHosts?.some((entry) => {
            const h = (typeof entry === "string" ? entry : entry.host)
              .trim()
              .toLowerCase()
              .replace(/^\[|\]$/g, "");
            return h === strippedHost;
          })
        );
      if (!isLoopbackAllowed) {
        return {
          allowed: false,
          code: "BLOCKED_PRIVATE_IP",
          reason: ipCheck.reason ?? `Loopback IP '${strippedHost}' is forbidden`,
          host,
          port,
        };
      }
    } else if (ipCheck.blocked) {
      if (options?.allowPrivateIps !== true) {
        return {
          allowed: false,
          code: "BLOCKED_PRIVATE_IP",
          reason: ipCheck.reason ?? `Private or reserved IP '${strippedHost}' is forbidden`,
          host,
          port,
        };
      }
    }
  }

  // 1. Cloud metadata addresses (Requirement 21.11, NE-01)
  if (isCloudMetadata(host)) {
    return {
      allowed: false,
      code: "BLOCKED_METADATA",
      reason: "Cloud metadata addresses (169.254.169.254) are forbidden",
      host,
      port,
    };
  }

  // 2. api.github.com (Requirement 21.11, NE-01, NE-02)
  if (host === "api.github.com") {
    return {
      allowed: false,
      code: "BLOCKED_API_GITHUB",
      reason: "api.github.com is forbidden to protect GitHub API credentials",
      host,
      port,
    };
  }

  // 3. Kiro host list (Requirement 21.11, Probe P11 input)
  const kiroHosts = options?.kiroHosts ?? configuredKiroHosts;
  if (kiroHosts.length > 0 && isKiroHost(host, kiroHosts)) {
    return {
      allowed: false,
      code: "BLOCKED_KIRO_HOST",
      reason: `Host '${host}' belongs to forbidden Kiro host list`,
      host,
      port,
    };
  }

  // 4. Custom blocked hosts
  if (options?.blockedHosts && options.blockedHosts.length > 0) {
    const isExplicitlyBlocked = options.blockedHosts.some(
      (b) => b.trim().toLowerCase() === host
    );
    if (isExplicitlyBlocked) {
      return {
        allowed: false,
        code: "BLOCKED_EXPLICIT",
        reason: `Host '${host}' is explicitly blocked`,
        host,
        port,
      };
    }
  }

  // 5. Allowlist check (Requirement 21.10, 43.8)
  const allowedHosts = options?.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const matchedEntry = allowedHosts
    .map((a) => matchAllowedEntry(host, a))
    .find((m) => m.matched);

  if (matchedEntry) {
    const reason =
      ALLOWED_HOST_REASONS[host] ?? "Host is permitted by egress allowlist";
    return {
      allowed: true,
      code: "ALLOWED",
      reason,
      host,
      port,
    };
  }

  // 6. Default deny (Requirement 21.9)
  return {
    allowed: false,
    code: "NOT_IN_ALLOWLIST",
    reason: `Host '${host}' is not in egress allowlist`,
    host,
    port,
  };
}

export function isHostAllowed(
  target: string,
  options?: ConnectProxyOptions
): boolean {
  return evaluateHost(target, options).allowed;
}

/**
 * Evaluate a CONNECT tunnel target against the full egress policy,
 * including the port restriction (audit item N-C8): by default only ports
 * 443 and 80 are accepted; an allowlist entry with a ports field is honored
 * for exactly those ports; any other port is refused with 403. A CONNECT
 * target without an explicit port follows the existing tunnel default of
 * 443.
 * Requirements: 21.9, 21.10, 43.11.
 */
export function evaluateConnectTarget(
  target: string,
  options?: ConnectProxyOptions
): HostEvaluationResult {
  const result = evaluateHost(target, options);
  if (!result.allowed) {
    return result;
  }

  const port = result.port ?? 443;
  const allowedHosts = options?.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const matchedEntry = allowedHosts
    .map((a) => matchAllowedEntry(result.host, a))
    .find((m) => m.matched);
  const allowedPorts = matchedEntry?.ports ?? DEFAULT_ALLOWED_PORTS;

  if (!allowedPorts.includes(port)) {
    return {
      allowed: false,
      code: "BLOCKED_PORT",
      reason: `Port ${port} is not permitted for CONNECT to '${result.host}'`,
      host: result.host,
      port,
    };
  }

  return result;
}

function createPinnedLookup(address: string, family: number) {
  return (
    _hostname: string,
    optionsOrCallback: any,
    maybeCallback?: any
  ) => {
    const cb =
      typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    const isAll =
      typeof optionsOrCallback === "object" &&
      optionsOrCallback !== null &&
      Boolean(optionsOrCallback.all);

    if (isAll) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  };
}

function resolveTargetHost(
  hostname: string,
  lookupFn?: ConnectProxyOptions["lookupFn"]
): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    const fn = lookupFn ?? dns.lookup;
    try {
      const cb = (err: any, addresses: any, family?: number) => {
        if (err) {
          return reject(err);
        }
        if (Array.isArray(addresses)) {
          return resolve(
            addresses.map((a: any) => ({
              address: typeof a === "string" ? a : a.address,
              family:
                typeof a === "object" && a !== null && a.family
                  ? a.family
                  : net.isIP(typeof a === "string" ? a : a.address) || 4,
            }))
          );
        }
        if (typeof addresses === "string") {
          return resolve([
            {
              address: addresses,
              family: family ?? (net.isIP(addresses) || 4),
            },
          ]);
        }
        if (addresses && typeof addresses === "object" && "address" in addresses) {
          return resolve([
            {
              address: (addresses as any).address,
              family: (addresses as any).family ?? (net.isIP((addresses as any).address) || 4),
            },
          ]);
        }
        resolve([]);
      };

      if (fn.length === 2) {
        (fn as any)(hostname, cb);
      } else {
        fn(hostname, { all: true } as dns.LookupOptions, cb);
      }
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Handle HTTPS CONNECT tunnel requests.
 * Requirements: 21.9, 21.11, 43.11.
 */
export function handleConnectRequest(
  req: http.IncomingMessage,
  clientSocket: stream.Duplex,
  head: Buffer,
  options?: ConnectProxyOptions
): void {
  const dest = req.url ?? "";
  const evalResult = evaluateConnectTarget(dest, options);

  if (!evalResult.allowed) {
    options?.onBlocked?.(evalResult, req);
    const body = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by egress policy: ${evalResult.reason}\r\n`;
    clientSocket.write(body);
    clientSocket.end();
    return;
  }

  const targetPort = evalResult.port ?? 443;
  const targetHost = evalResult.host;
  const strippedTarget = targetHost.replace(/^\[|\]$/g, "").split("%")[0];
  const isIpLiteral = net.isIP(strippedTarget) !== 0;

  const proceedWithTarget = (pinnedLookup?: (hostname: string, opts: any, cb?: any) => void) => {
    if (clientSocket.destroyed) return;

    options?.onAllowed?.({ host: evalResult.host, port: evalResult.port }, req);

    const connectOpts: net.TcpNetConnectOpts = {
      host: targetHost,
      port: targetPort,
    };
    if (pinnedLookup) {
      connectOpts.lookup = pinnedLookup as any;
    }

    const upstream = net.connect(connectOpts, () => {
      const remoteIp = upstream.remoteAddress ?? "";
      const ipCheck = isPrivateOrReservedIp(remoteIp);
      const isLoopbackAllowed =
        ipCheck.isLoopback &&
        options?.allowedHosts?.some((entry) => {
          const h = (typeof entry === "string" ? entry : entry.host)
            .trim()
            .toLowerCase()
            .replace(/^\[|\]$/g, "");
          return (
            h === remoteIp.toLowerCase() ||
            (targetHost && h === targetHost.toLowerCase())
          );
        });

      if (ipCheck.blocked && !isLoopbackAllowed && options?.allowPrivateIps !== true) {
        upstream.destroy();
        clientSocket.destroy();
        return;
      }

      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) {
        upstream.write(head);
      }
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on("error", () => {
      if (!clientSocket.destroyed) {
        clientSocket.write(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway\r\n"
        );
        clientSocket.end();
      }
    });

    clientSocket.on("error", () => {
      upstream.destroy();
    });
  };

  if (isIpLiteral) {
    proceedWithTarget();
    return;
  }

  resolveTargetHost(targetHost, options?.lookupFn)
    .then((resolved) => {
      if (clientSocket.destroyed) return;

      if (!resolved || resolved.length === 0) {
        clientSocket.write(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway\r\n"
        );
        clientSocket.end();
        return;
      }

      let blockedAddr:
        | { address: string; family: number; check: ReturnType<typeof isPrivateOrReservedIp> }
        | undefined;
      for (const addr of resolved) {
        const check = isPrivateOrReservedIp(addr.address);
        if (check.blocked && options?.allowPrivateIps !== true) {
          if (!blockedAddr || (!blockedAddr.check.isMetadata && check.isMetadata)) {
            blockedAddr = { ...addr, check };
          }
        }
      }

      if (blockedAddr) {
        const code: EvaluationCode = blockedAddr.check.isMetadata
          ? "BLOCKED_METADATA"
          : "BLOCKED_PRIVATE_IP";
        const reason =
          blockedAddr.check.reason ??
          (blockedAddr.check.isMetadata
            ? `Cloud metadata destination (${blockedAddr.address}) is forbidden`
            : `Private or reserved destination IP (${blockedAddr.address}) is forbidden`);
        const blockResult: HostEvaluationResult = {
          allowed: false,
          code,
          reason,
          host: targetHost,
          port: targetPort,
        };
        options?.onBlocked?.(blockResult, req);
        const body = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by egress policy: ${reason}\r\n`;
        clientSocket.write(body);
        clientSocket.end();
        return;
      }

      const pinned = resolved[0];
      const pinnedLookup = createPinnedLookup(pinned.address, pinned.family);
      proceedWithTarget(pinnedLookup);
    })
    .catch(() => {
      if (!clientSocket.destroyed) {
        clientSocket.write(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBad Gateway\r\n"
        );
        clientSocket.end();
      }
    });
}

/**
 * Handle HTTP forward proxy requests.
 * Requirements: 21.9, 21.11, 43.11.
 */
export function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: ConnectProxyOptions
): void {
  const hostHeader = req.headers.host;
  let targetUrl = req.url ?? "";
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    if (!hostHeader) {
      const payload = JSON.stringify({
        error: "Missing Host header or absolute target URL",
        code: "INVALID_TARGET",
      });
      res.writeHead(400, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "close",
      });
      res.end(payload);
      return;
    }
    targetUrl = `http://${hostHeader}${targetUrl.startsWith("/") ? "" : "/"}${targetUrl}`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    const payload = JSON.stringify({
      error: "Invalid target URL or port",
      code: "INVALID_TARGET",
    });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Connection: "close",
    });
    res.end(payload);
    return;
  }

  if (parsedUrl.protocol === "https:") {
    const payload = JSON.stringify({
      error: "HTTPS targets must use CONNECT tunnel",
      code: "INVALID_TARGET",
    });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Connection: "close",
    });
    res.end(payload);
    return;
  }

  if (parsedUrl.protocol !== "http:") {
    const payload = JSON.stringify({
      error: `Unsupported protocol: ${parsedUrl.protocol}`,
      code: "INVALID_TARGET",
    });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Connection: "close",
    });
    res.end(payload);
    return;
  }

  let port: number;
  if (parsedUrl.port) {
    const parsedPort = Number(parsedUrl.port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      const payload = JSON.stringify({
        error: `Invalid or out-of-range port: ${parsedUrl.port}`,
        code: "INVALID_TARGET",
      });
      res.writeHead(400, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "close",
      });
      res.end(payload);
      return;
    }
    port = parsedPort;
  } else {
    port = 80;
  }

  const targetHost = parsedUrl.hostname.replace(/\.$/, "").toLowerCase();
  if (!targetHost) {
    const payload = JSON.stringify({
      error: "Empty or invalid host",
      code: "INVALID_TARGET",
    });
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Connection: "close",
    });
    res.end(payload);
    return;
  }

  const evalResult = evaluateConnectTarget(`${targetHost}:${port}`, options);

  if (!evalResult.allowed) {
    if (evalResult.code === "BLOCKED_PORT") {
      options?.onBlockedRequest?.(targetHost, port, evalResult.reason);
      options?.onBlocked?.(evalResult, req);
      console.warn(
        `[connect-proxy] Blocked plain HTTP request to ${targetHost}:${port}: ${evalResult.reason}`
      );
      const payload = JSON.stringify({
        error: evalResult.reason,
        code: "BLOCKED_PORT",
        host: targetHost,
      });
      res.writeHead(403, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "close",
      });
      res.end(payload);
      return;
    }

    options?.onBlocked?.(evalResult, req);
    res.writeHead(403, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    res.end(`Blocked by egress policy: ${evalResult.reason}\r\n`);
    return;
  }

  const strippedTarget = targetHost.replace(/^\[|\]$/g, "").split("%")[0];
  const isIpLiteral = net.isIP(strippedTarget) !== 0;

  const forwardRequest = (pinnedLookup?: (hostname: string, opts: any, cb?: any) => void) => {
    options?.onAllowed?.({ host: evalResult.host, port }, req);

    try {
      const outgoingHeaders = { ...req.headers };
      delete outgoingHeaders["proxy-connection"];

      const reqOpts: http.RequestOptions = {
        hostname: evalResult.host,
        port,
        method: req.method,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: outgoingHeaders,
      };
      if (pinnedLookup) {
        reqOpts.lookup = pinnedLookup as any;
      }

      const upstreamReq = http.request(reqOpts, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        upstreamRes.pipe(res);
      });

      upstreamReq.on("socket", (socket: net.Socket) => {
        const checkSocket = () => {
          const remoteIp = socket.remoteAddress ?? "";
          const ipCheck = isPrivateOrReservedIp(remoteIp);
          const isLoopbackAllowed =
            ipCheck.isLoopback &&
            options?.allowedHosts?.some((entry) => {
              const h = (typeof entry === "string" ? entry : entry.host)
                .trim()
                .toLowerCase()
                .replace(/^\[|\]$/g, "");
              return (
                h === remoteIp.toLowerCase() ||
                (targetHost && h === targetHost.toLowerCase())
              );
            });

          if (ipCheck.blocked && !isLoopbackAllowed && options?.allowPrivateIps !== true) {
            socket.destroy();
            upstreamReq.destroy();
            req.socket?.destroy();
          }
        };

        if (socket.connecting) {
          socket.once("connect", checkSocket);
        } else {
          checkSocket();
        }
      });

      upstreamReq.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, {
            "Content-Type": "text/plain",
            Connection: "close",
          });
          res.end("502 Bad Gateway\r\n");
        }
      });

      req.on("error", () => {
        upstreamReq.destroy();
      });

      req.pipe(upstreamReq);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, {
          "Content-Type": "application/json",
          Connection: "close",
        });
        res.end(
          JSON.stringify({
            error: "Invalid request",
            code: "INVALID_TARGET",
          })
        );
      }
    }
  };

  if (isIpLiteral) {
    forwardRequest();
    return;
  }

  req.pause();
  resolveTargetHost(targetHost, options?.lookupFn)
    .then((resolved) => {
      req.resume();

      if (!resolved || resolved.length === 0) {
        if (!res.headersSent) {
          res.writeHead(502, {
            "Content-Type": "text/plain",
            Connection: "close",
          });
          res.end("502 Bad Gateway\r\n");
        }
        return;
      }

      let blockedAddr:
        | { address: string; family: number; check: ReturnType<typeof isPrivateOrReservedIp> }
        | undefined;
      for (const addr of resolved) {
        const check = isPrivateOrReservedIp(addr.address);
        if (check.blocked && options?.allowPrivateIps !== true) {
          if (!blockedAddr || (!blockedAddr.check.isMetadata && check.isMetadata)) {
            blockedAddr = { ...addr, check };
          }
        }
      }

      if (blockedAddr) {
        const code: EvaluationCode = blockedAddr.check.isMetadata
          ? "BLOCKED_METADATA"
          : "BLOCKED_PRIVATE_IP";
        const reason =
          blockedAddr.check.reason ??
          (blockedAddr.check.isMetadata
            ? `Cloud metadata destination (${blockedAddr.address}) is forbidden`
            : `Private or reserved destination IP (${blockedAddr.address}) is forbidden`);
        const blockResult: HostEvaluationResult = {
          allowed: false,
          code,
          reason,
          host: targetHost,
          port,
        };
        options?.onBlocked?.(blockResult, req);
        if (!res.headersSent) {
          res.writeHead(403, {
            "Content-Type": "text/plain",
            Connection: "close",
          });
          res.end(`Blocked by egress policy: ${reason}\r\n`);
        }
        return;
      }

      const pinned = resolved[0];
      const pinnedLookup = createPinnedLookup(pinned.address, pinned.family);
      forwardRequest(pinnedLookup);
    })
    .catch(() => {
      req.resume();
      if (!res.headersSent) {
        res.writeHead(502, {
          "Content-Type": "text/plain",
          Connection: "close",
        });
        res.end("502 Bad Gateway\r\n");
      }
    });
}

/**
 * Create HTTP/HTTPS CONNECT forward proxy server.
 * Requirements: 21.9, 21.10, 21.11, 43.8, 43.11.
 */
export function createConnectProxy(options?: ConnectProxyOptions): http.Server {
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, options);
  });

  server.on("connect", (req, clientSocket, head) => {
    handleConnectRequest(req, clientSocket, head, options);
  });

  return server;
}

export const createConnectProxyServer = createConnectProxy;

/**
 * Proxy instance managing server lifecycle.
 */
export class ConnectProxy {
  private server: http.Server | null = null;
  private options: ConnectProxyOptions;
  private activePort: number | null = null;
  private activeHost: string | null = null;

  constructor(options: ConnectProxyOptions = {}) {
    this.options = { ...options };
  }

  setKiroHosts(hosts: readonly string[]): void {
    this.options.kiroHosts = [...hosts];
  }

  getKiroHosts(): readonly string[] {
    return this.options.kiroHosts ?? [];
  }

  evaluateHost(target: string): HostEvaluationResult {
    return evaluateHost(target, this.options);
  }

  isHostAllowed(target: string): boolean {
    return isHostAllowed(target, this.options);
  }

  async start(port = 0, host = "127.0.0.1"): Promise<{ port: number; host: string; url: string }> {
    if (this.server) {
      return {
        port: this.activePort!,
        host: this.activeHost!,
        url: `http://${this.activeHost}:${this.activePort}`,
      };
    }

    return new Promise((resolve, reject) => {
      const server = createConnectProxy(this.options);
      server.listen(port, host, () => {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) {
          this.activePort = addr.port;
          this.activeHost = addr.address;
        } else {
          this.activePort = port;
          this.activeHost = host;
        }
        this.server = server;
        resolve({
          port: this.activePort,
          host: this.activeHost,
          url: `http://${this.activeHost}:${this.activePort}`,
        });
      });
      server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        this.activePort = null;
        this.activeHost = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    return this.stop();
  }

  getServer(): http.Server | null {
    return this.server;
  }

  getPort(): number | null {
    return this.activePort;
  }

  getUrl(): string | null {
    return this.activePort ? `http://${this.activeHost}:${this.activePort}` : null;
  }
}

export async function startConnectProxy(
  options?: ConnectProxyOptions
): Promise<ConnectProxy> {
  const proxy = new ConnectProxy(options);
  await proxy.start(options?.port ?? 0, options?.host ?? "127.0.0.1");
  return proxy;
}
