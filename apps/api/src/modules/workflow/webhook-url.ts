import dns from "node:dns";
import https from "node:https";
import type { LookupFunction } from "node:net";

/**
 * WHERE A WEBHOOK IS ALLOWED TO GO, AND HOW IT IS ALLOWED TO GET THERE — QNEW-90 item 3.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────────────────────────
 * Before the webhook action there was exactly ONE outbound HTTP call in this entire codebase:
 * common/ai.service.ts, to a hostname written in the source. The webhook is the first request whose
 * DESTINATION IS CHOSEN BY A USER — anyone who can author a workflow — issued from a process that
 * can reach the database, every other service on the box, the container network, and, on any cloud
 * host, the instance metadata endpoint that hands out credentials to whoever asks.
 *
 * An unguarded webhook action is therefore not "a feature that calls a URL". It is a "fetch any URL
 * for me, from inside the trust boundary, and tell me what came back" primitive. Everything in this
 * file exists to make that sentence false, which is why it lives apart from the action that uses it
 * and has its own test (scripts/prove-ssrf-guard.ts) driving every spelling we could think of.
 *
 * ── THE FOUR RULES ──────────────────────────────────────────────────────────────────────────────
 *  1. https only. Not http (the body and the signature would cross the network in clear), and not
 *     file:, gopher:, ftp:, data: or anything else — a scheme allowlist of exactly one entry.
 *  2. The destination must be a PUBLIC address. Loopback, private, link-local, unique-local,
 *     carrier-NAT, multicast, documentation and reserved space are all refused, on IPv4 and IPv6,
 *     with the cloud metadata address called out by name because it is the single most valuable
 *     target on the list.
 *  3. THE ADDRESS IS RESOLVED AND JUDGED AT SEND TIME, AND THE CONNECTION GOES TO THE ADDRESS THAT
 *     WAS JUDGED. See makeGuardedLookup below — this is the part that a check at configuration time
 *     cannot do, and it is the difference between a guard and a formality.
 *  4. No redirects, a bounded amount of time, and a bounded amount of response body.
 *
 * ── WHY VALIDATING THE STRING IS NOT ENOUGH ─────────────────────────────────────────────────────
 * "127.0.0.1" is only one of its spellings. 0x7f.1, 2130706433, 127.1, [::1], [::ffff:7f00:1] and a
 * hostname somebody controls that simply has an A record pointing at 127.0.0.1 all reach the same
 * place. Two layers already normalise most of that for us — the WHATWG URL parser rewrites
 * "https://0x7f.1/" to host 127.0.0.1, and getaddrinfo resolves the rest — and neither of them is
 * the point. The point is that we never trust the STRING: what gets classified is the address the
 * resolver actually returned, and what gets connected to is that same address.
 *
 * ── DNS REBINDING, WHICH IS WHY THE CHECK IS WHERE IT IS ────────────────────────────────────────
 * A name that resolves to a public address when the flow is saved, and to 127.0.0.1 thirty seconds
 * later, defeats any check made at configuration time — the attacker owns the zone and can answer
 * differently every time, with a one-second TTL. It also defeats the naive send-time check
 * "resolve it, decide, then hand the hostname to the HTTP client", because the client resolves it
 * AGAIN and gets the second answer. So the resolution and the connection must be the same event:
 * makeGuardedLookup is installed as the socket's own resolver, so the address the guard approved is
 * by construction the address the TCP connection is opened to. There is no window between them.
 */

/**
 * The address rules in force for one request.
 *
 * IT IS A PARAMETER RATHER THAN A CONSTANT FOR ONE REASON, AND IT IS NOT FLEXIBILITY. A guard that
 * refuses every address a test machine can reach cannot be tested against a real listener, and
 * "we asserted the row changed state" is not the same claim as "a real HTTP request was made and it
 * was signed correctly". So the loose values exist, and the following two properties are what keep
 * them from being a hole:
 *
 *   • NOTHING AT RUN TIME CAN SELECT THEM. There is no environment variable, no column, no request
 *     header and no configuration file behind this. The only way to obtain a policy that permits
 *     loopback is to write it into the source of a program, which the test does and no shipped code
 *     path does.
 *   • guard-check.sh asserts that literally: `allowLoopback: true` and `trustAnyCertificate: true`
 *     appear ZERO times in the CODE under src/ — comment lines, such as this one, are stripped
 *     before counting. If somebody ever wires one up, the suite says so.
 *
 * An `if (process.env.ALLOW_INSECURE_WEBHOOKS)` would have been three fewer lines and exactly the
 * kind of switch that gets set on a staging box and then inherited by production.
 */
export interface AddressPolicy {
  /** Permit loopback and private space. FALSE everywhere except in-process tests. */
  allowLoopback: boolean;
  /** Skip TLS certificate verification. FALSE everywhere except in-process tests. */
  trustAnyCertificate: boolean;
}

/** The only policy any shipped code path passes. */
export const PUBLIC_ONLY: AddressPolicy = Object.freeze({
  allowLoopback: false,
  trustAnyCertificate: false,
});

/**
 * A destination this system refuses to reach. Distinct from a transport failure on purpose: the
 * dispatcher records "we would not call that" and "we called it and it did not answer" as different
 * sentences, because they need different fixes from different people.
 */
export class WebhookRefusedError extends Error {
  override readonly name = "WebhookRefusedError";
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };
export type AddressVerdict = { ok: true } | { ok: false; reason: string };

/** How long we will wait for a socket to produce ANY activity — connect, TLS, or a byte of reply. */
const IDLE_TIMEOUT_MS = 5_000;
/** How long the whole exchange may take, however lively the socket is. A receiver that trickles one
 *  byte a second forever would never trip the idle timer, and would hold a dispatcher slot for as
 *  long as it felt like. */
const TOTAL_TIMEOUT_MS = 10_000;
/** How much reply we will read. We want a diagnostic snippet, not a download: a receiver answering
 *  a 500 with a two-gigabyte stack trace must cost us eight kilobytes and then a closed socket. */
const MAX_RESPONSE_BYTES = 8 * 1024;
/** Longest destination we will store or dial. Matches the CHECK on workflow_webhook_outbox.url. */
export const MAX_URL_LENGTH = 2048;

// ── address classification ────────────────────────────────────────────────────────────────────

/** Dotted quad → 32-bit integer, or null if it is not one. Strict: no octal, no hex, no shorthand,
 *  because this only ever sees output from the resolver, which is always canonical. */
function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** IPv6 text → 16 bytes, or null. Handles "::" compression, a trailing embedded IPv4 literal, and
 *  a "%zone" suffix (which a link-local address on a multi-homed box really does carry). */
function parseIpv6(text: string): Uint8Array | null {
  const withoutZone = text.includes("%") ? text.slice(0, text.indexOf("%")) : text;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === "") return [];
    const words: number[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (i === groups.length - 1 && group.includes(".")) {
        const embedded = parseIpv4(group);
        if (embedded === null) return null;
        words.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      words.push(parseInt(group, 16));
    }
    return words;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;

  let words: number[];
  if (halves.length === 2) {
    const gap = 8 - head.length - tail.length;
    if (gap < 0) return null;
    words = [...head, ...new Array<number>(gap).fill(0), ...tail];
  } else {
    words = head;
  }
  if (words.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (words[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = words[i] & 0xff;
  }
  return bytes;
}

/**
 * IPv4 space we refuse, from the IANA Special-Purpose Address Registry. A BLOCKLIST here rather
 * than an allowlist because public IPv4 is "everything that is not one of these" — there is no
 * prefix that means "global unicast" the way there is in IPv6.
 */
const IPV4_REFUSED: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "the unspecified 'this network' range"],
  ["10.0.0.0", 8, "a private network (RFC 1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT space (RFC 6598)"],
  ["127.0.0.0", 8, "loopback — that is this machine"],
  ["169.254.0.0", 16, "link-local space, where cloud instance metadata lives"],
  ["172.16.0.0", 12, "a private network (RFC 1918)"],
  ["192.0.0.0", 24, "reserved for IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation space (TEST-NET-1)"],
  ["192.88.99.0", 24, "the deprecated 6to4 relay anycast range"],
  ["192.168.0.0", 16, "a private network (RFC 1918)"],
  ["198.18.0.0", 15, "benchmarking space (RFC 2544)"],
  ["198.51.100.0", 24, "documentation space (TEST-NET-2)"],
  ["203.0.113.0", 24, "documentation space (TEST-NET-3)"],
  ["224.0.0.0", 4, "multicast, which is not a destination a webhook can have"],
  ["240.0.0.0", 4, "reserved space, including the broadcast address"],
];

/**
 * THE CLOUD METADATA ENDPOINT, NAMED. It is inside 169.254.0.0/16 and the range check below would
 * refuse it anyway, so this entry buys exactly one thing and it is worth having: the refusal says
 * what was actually being attempted. On EC2, GCE and Azure this address hands out IAM credentials
 * to any process that asks it, with no authentication at all, which makes "make the server fetch a
 * URL for me" and "give me the server's cloud credentials" the same request. Anybody reading a
 * refusal in the run log should see that named rather than inferring it from a CIDR.
 */
const CLOUD_METADATA_IPV4 = "169.254.169.254";
/** The same service on its IPv6 address. In fe80::/10, so again already covered — named for the
 *  same reason. */
const CLOUD_METADATA_IPV6 = "fe80::a9fe:a9fe";

/** IPv6 prefixes carved OUT of global unicast that must still be refused, as [bytes, bit length]. */
const IPV6_REFUSED_WITHIN_GLOBAL: ReadonlyArray<readonly [string, number, string]> = [
  ["2001:0000::", 32, "Teredo tunnelling space, which carries an embedded IPv4 destination"],
  ["2001:0010::", 28, "ORCHID space"],
  ["2001:0020::", 28, "ORCHIDv2 space"],
  ["2001:0db8::", 32, "documentation space"],
  ["2002::", 16, "6to4 tunnelling space, which carries an embedded IPv4 destination"],
  ["3fff::", 20, "documentation space (RFC 9637)"],
];

function inV4Range(address: number, network: string, bits: number): boolean {
  const base = parseIpv4(network);
  if (base === null) return false;
  // A /0 would shift by 32, which in JavaScript is a no-op rather than a wipe. No entry uses it,
  // but the arithmetic is written so that adding one later cannot silently match nothing.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}

function inV6Range(address: Uint8Array, network: string, bits: number): boolean {
  const base = parseIpv6(network);
  if (base === null) return false;
  const wholeBytes = bits >> 3;
  for (let i = 0; i < wholeBytes; i++) if (address[i] !== base[i]) return false;
  const remainder = bits & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (address[wholeBytes] & mask) === (base[wholeBytes] & mask);
}

/**
 * Is this a public address we are willing to talk to?
 *
 * WHAT IT IS GIVEN is the string a resolver produced — canonical, already normalised — never a
 * string a user typed. That is the invariant the strict parsers above rely on.
 *
 * THE TWO FAMILIES ARE JUDGED DIFFERENTLY, and deliberately:
 *   IPv4 is a blocklist, because "public" is defined by subtraction (see IPV4_REFUSED).
 *   IPv6 is an ALLOWLIST — the address must sit in 2000::/3, the only range IANA has ever handed
 *   out for global unicast — with the handful of special prefixes inside it carved back out. That
 *   is the safer default of the two: an IPv6 range invented after this code was written is refused
 *   until somebody looks at it, rather than allowed until somebody notices.
 */
export function classifyAddress(address: string, policy: AddressPolicy = PUBLIC_ONLY): AddressVerdict {
  const v4 = parseIpv4(address);
  if (v4 !== null) {
    if (address === CLOUD_METADATA_IPV4 && !policy.allowLoopback)
      return { ok: false, reason: "the cloud instance metadata service (169.254.169.254)" };
    for (const [network, bits, why] of IPV4_REFUSED) {
      if (!inV4Range(v4, network, bits)) continue;
      // The loose policy exists for in-process tests only, and it opens loopback and private space
      // — never multicast, never the metadata endpoint, because no test needs those and a test-only
      // switch should still be the smallest hole that does the job.
      const testable = network === "127.0.0.0" || network === "10.0.0.0"
        || network === "172.16.0.0" || network === "192.168.0.0";
      if (policy.allowLoopback && testable) return { ok: true };
      return { ok: false, reason: `${why} (${network}/${bits})` };
    }
    return { ok: true };
  }

  const v6 = parseIpv6(address);
  if (v6 === null) return { ok: false, reason: "not an address this server can classify" };

  const allZero = v6.every((b) => b === 0);
  if (allZero) return { ok: false, reason: "the unspecified address (::)" };
  if (inV6Range(v6, "::1", 128)) {
    if (policy.allowLoopback) return { ok: true };
    return { ok: false, reason: "IPv6 loopback (::1) — that is this machine" };
  }
  // ::ffff:0:0/96 and 64:ff9b::/96 both carry a real IPv4 destination in their last four bytes.
  // Judging the address they actually reach — rather than refusing the whole prefix — is what makes
  // the refusal say "127.0.0.1" instead of "some IPv6 range", which is the sentence a reader needs.
  if (inV6Range(v6, "::ffff:0:0", 96) || inV6Range(v6, "64:ff9b::", 96)) {
    const embedded = `${v6[12]}.${v6[13]}.${v6[14]}.${v6[15]}`;
    const inner = classifyAddress(embedded, policy);
    return inner.ok ? inner : { ok: false, reason: `${inner.reason}, reached through ${address}` };
  }
  if (inV6Range(v6, "fe80::", 10)) {
    if (address.toLowerCase().startsWith(CLOUD_METADATA_IPV6))
      return { ok: false, reason: "the cloud instance metadata service (fe80::a9fe:a9fe)" };
    return { ok: false, reason: "IPv6 link-local space (fe80::/10)" };
  }
  if (inV6Range(v6, "fc00::", 7)) {
    if (policy.allowLoopback) return { ok: true };
    return { ok: false, reason: "IPv6 unique-local space (fc00::/7)" };
  }
  if (inV6Range(v6, "ff00::", 8)) return { ok: false, reason: "IPv6 multicast (ff00::/8)" };
  if (inV6Range(v6, "100::", 64)) return { ok: false, reason: "the IPv6 discard-only range (100::/64)" };

  // The allowlist. Everything that is not global unicast stops here, including every range IANA has
  // not allocated yet.
  if (!inV6Range(v6, "2000::", 3))
    return { ok: false, reason: "outside IPv6 global unicast space (2000::/3)" };
  for (const [network, bits, why] of IPV6_REFUSED_WITHIN_GLOBAL)
    if (inV6Range(v6, network, bits)) return { ok: false, reason: `${why} (${network}/${bits})` };

  return { ok: true };
}

// ── the URL itself ────────────────────────────────────────────────────────────────────────────

/**
 * Everything about a destination that can be judged WITHOUT asking a resolver.
 *
 * This is what the action runs at configuration time, and what the dispatcher runs again before
 * dialling. It deliberately does NOT resolve the hostname, and that is not laziness:
 *
 *   • resolving here would put a DNS round trip inside somebody's business transaction, on the
 *     status-move path, where every millisecond is a lock held on a real order;
 *   • and it would be worth nothing anyway. An answer obtained when the flow was saved says
 *     nothing about the answer the socket will get days later — see the rebinding note at the top
 *     of this file. The authority is the check in makeGuardedLookup; this is the early refusal that
 *     lets an admin find out about a typed http:// while they are still looking at the form.
 *
 * A LITERAL ADDRESS IS JUDGED HERE, though, because there is nothing to resolve: the WHATWG parser
 * has already rewritten 0x7f.1, 2130706433 and 127.1 to 127.0.0.1 by the time we see the hostname.
 */
export function validateWebhookUrl(raw: string, policy: AddressPolicy = PUBLIC_ONLY): UrlVerdict {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "no destination was given" };
  if (text.length > MAX_URL_LENGTH)
    return { ok: false, reason: `the destination is longer than ${MAX_URL_LENGTH} characters` };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `'${text.slice(0, 80)}' is not a URL` };
  }

  if (url.protocol !== "https:")
    return {
      ok: false,
      reason:
        `'${url.protocol.replace(":", "")}' is not a scheme this server will call — https only. ` +
        `Plain http would put the payload and its signature on the wire in clear.`,
    };
  // Credentials in the URL would be a password stored in a jsonb column, echoed into the run log
  // and into every error message that quotes the destination. The signature is how a receiver knows
  // it is us; there is nothing for basic auth to add.
  if (url.username || url.password)
    return { ok: false, reason: "a destination may not carry a username or a password" };
  if (url.hash)
    return { ok: false, reason: "a destination may not carry a #fragment — it is never sent" };
  if (!url.hostname) return { ok: false, reason: "the destination has no host" };

  // The NORMALISED form is what gets stored and dialled, and normalising can lengthen a URL (a bare
  // host gains a trailing slash, an escaped character becomes three). Checking only the raw input
  // would let a value through here that workflow_webhook_outbox.url then refuses, turning a clear
  // "that is too long" into a constraint violation inside somebody's status move.
  if (url.toString().length > MAX_URL_LENGTH)
    return { ok: false, reason: `the destination is longer than ${MAX_URL_LENGTH} characters` };

  // Strips the brackets an IPv6 literal carries in URL.hostname, so "[::1]" is classified as "::1".
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (parseIpv4(host) !== null || host.includes(":")) {
    const verdict = classifyAddress(host, policy);
    if (!verdict.ok) return { ok: false, reason: `${host} is ${verdict.reason}` };
  }

  // NAMES THAT MEAN "THIS MACHINE", refused without resolving anything.
  //
  // Everything above this point classifies a literal address, so a NAME reaches the dialler and is
  // judged there — which is safe, because the resolver decides and the socket cannot be pointed
  // anywhere else afterwards. But safe-later is not the same as told-now: an admin who types
  // `localhost` saves cleanly, activates, and finds out weeks later from a run log they are not
  // watching. These names cannot legitimately be a customer's webhook, and refusing them by name
  // costs nothing and needs no DNS, so the mistake is caught while the person is still looking at it.
  //
  // This list is a COURTESY, not the defence. Anything it misses — a hostname with an A record
  // pointing at 127.0.0.1, a name that changes its answer after we check — is still stopped at dial
  // time by guardedLookup below, which is the part that actually has to be right.
  if (!policy?.allowLoopback && isLocalName(host))
    return { ok: false, reason: `'${host}' names this machine` };

  return { ok: true, url };
}


/**
 * Names that resolve to this machine, or to a network only this machine can see. Compared after
 * lowercasing and dropping a trailing dot, because DNS treats "LocalHost." and "localhost" as the
 * same name and a check that did not would be trivially stepped around.
 */
const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
/** Suffixes whose whole point is to name something inside the network we are running in. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (LOCAL_NAMES.has(h)) return true;
  return LOCAL_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// ── the guarded send ──────────────────────────────────────────────────────────────────────────

/**
 * The socket's own resolver. THIS IS THE LOAD-BEARING PIECE OF THE WHOLE FILE.
 *
 * Node hands `lookup` to net.connect, so whatever address this function returns is the address the
 * TCP connection is opened to — there is no second resolution, and therefore no window in which the
 * answer could change between being judged and being used.
 *
 * IT ONLY RUNS FOR A NAME. net.connect skips resolution entirely when the host is already an IP
 * literal, so nothing here is on the code path for `https://169.254.169.254/` — that case is
 * refused by postGuarded itself, before the request is built. Do not move that check without
 * reading this paragraph: the two together are what make "judged at send time" true of every
 * destination rather than only of the ones that happen to need DNS.
 *
 * EVERY RETURNED ADDRESS MUST PASS, not just the one we would have used. A name that answers with
 * a public address and a loopback address is not a name with one usable address; it is a name whose
 * owner is trying something. Refusing the whole answer costs us nothing legitimate — a real
 * receiver's A records all point at the same service — and closes the door on happy-eyeballs or a
 * connection retry quietly picking the address we had decided against.
 */
function makeGuardedLookup(policy: AddressPolicy): LookupFunction {
  return ((hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, resolved) => {
      if (err) return callback(err, "", 0);
      const addresses = resolved as dns.LookupAddress[];
      if (!addresses.length)
        return callback(new WebhookRefusedError(`${hostname} resolved to no address`), "", 0);
      for (const entry of addresses) {
        const verdict = classifyAddress(entry.address, policy);
        if (!verdict.ok)
          return callback(
            new WebhookRefusedError(`${hostname} resolves to ${entry.address}, which is ${verdict.reason}`),
            "",
            0,
          );
      }
      // net.connect asks for the whole list when it is doing happy-eyeballs and for a single
      // address otherwise. Both are answered from the SAME approved set.
      if ((options as dns.LookupAllOptions).all === true)
        return (callback as unknown as (e: NodeJS.ErrnoException | null, a: dns.LookupAddress[]) => void)(
          null,
          addresses,
        );
      callback(null, addresses[0].address, addresses[0].family);
    });
  }) as LookupFunction;
}

export interface GuardedResponse {
  status: number;
  /** At most MAX_RESPONSE_BYTES of it, for the error line. Never parsed, never acted on. */
  body: string;
}

/**
 * POST a body to a validated destination, resolving and judging the address on the way.
 *
 * REDIRECTS ARE NOT FOLLOWED, AND THAT IS THE SIMPLEST CORRECT ANSWER TO THE HARDEST PART OF THIS.
 * A guard that checks only the first URL is defeated by a receiver that answers 302 with
 * Location: http://169.254.169.254/… — the check passed, and then the HTTP client cheerfully went
 * somewhere nobody validated. Following redirects safely means re-running every rule in this file
 * on every hop and bounding the chain, and node:https does not follow them on its own, so the
 * correct thing to do is to leave it that way and say so. A 3xx is reported to the caller as the
 * status it is; the dispatcher records it as a failure with a message naming the reason, so a
 * receiver behind a redirect gets told to publish the final URL instead.
 */
export async function postGuarded(
  url: URL,
  body: string,
  headers: Record<string, string>,
  policy: AddressPolicy,
): Promise<GuardedResponse> {
  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      fn();
    };

    const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");

    // A LITERAL ADDRESS IS JUDGED HERE, BECAUSE makeGuardedLookup WILL NEVER SEE IT.
    //
    // net.connect calls the `lookup` function only when it has a NAME to resolve. Given an IP
    // literal it skips resolution altogether and opens the socket straight away — which means the
    // guard installed below, the one this whole file is arranged around, is simply not on the code
    // path for `https://169.254.169.254/`. That was demonstrated rather than assumed: a custom
    // lookup that fails every call is never invoked for host '127.0.0.1', and the connection
    // succeeds.
    //
    // Today the dispatcher happens to be safe anyway, because send() runs validateWebhookUrl on the
    // stored row first and that classifies literal hosts. But this function is exported, its
    // documented contract is that the address is judged at send time, and relying on a caller to
    // have already done the check is how the check stops being done. One refusal, in the function
    // that opens the socket.
    if (parseIpv4(hostname) !== null || hostname.includes(":")) {
      const verdict = classifyAddress(hostname, policy);
      if (!verdict.ok) return reject(new WebhookRefusedError(`${hostname} is ${verdict.reason}`));
    }

    const request = https.request(
      {
        protocol: "https:",
        hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(body) },
        // A one-shot agent, so no socket is ever reused between deliveries. Pooling would key
        // sockets by host and port alone, which would let a connection opened for one destination
        // serve another request that had not been through this lookup.
        agent: new https.Agent({ keepAlive: false, maxSockets: 1 }),
        lookup: makeGuardedLookup(policy),
        rejectUnauthorized: !policy.trustAnyCertificate,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let read = 0;
        const done = () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_RESPONSE_BYTES),
            }),
          );
        response.on("data", (chunk: Buffer) => {
          if (read >= MAX_RESPONSE_BYTES) return;
          read += chunk.length;
          chunks.push(chunk);
          // Enough to diagnose with. Anything past this is somebody else's disk, not ours.
          if (read >= MAX_RESPONSE_BYTES) response.destroy();
        });
        response.on("end", done);
        // 'end' does not fire on a stream we destroyed above, so the cap needs 'close' to settle.
        response.on("close", done);
        response.on("error", (e) => finish(() => reject(e)));
      },
    );

    // Two timers, because they answer two different failure modes. setTimeout() on the request is
    // an IDLE timer: it fires when nothing at all happens for a while, which covers a black-holed
    // connect and a receiver that accepts the body and never replies.
    request.setTimeout(IDLE_TIMEOUT_MS, () =>
      request.destroy(new Error(`no response within ${IDLE_TIMEOUT_MS}ms`)),
    );
    // And a wall clock, because a receiver that emits one byte every four seconds resets the idle
    // timer forever while holding a dispatcher slot.
    const totalTimer = setTimeout(
      () => request.destroy(new Error(`the exchange did not finish within ${TOTAL_TIMEOUT_MS}ms`)),
      TOTAL_TIMEOUT_MS,
    );
    // The timer must never be the reason node stays alive; the dispatcher's own tick is unref'd for
    // the same reason.
    totalTimer.unref?.();

    request.on("error", (e) => finish(() => reject(e)));
    request.end(body);
  });
}
