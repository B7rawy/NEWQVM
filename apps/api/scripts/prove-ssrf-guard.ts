/**
 * prove-ssrf-guard.ts — the test that belongs to src/modules/workflow/webhook-url.ts.
 *
 * The webhook action is the first thing in this system that makes an outbound request to a
 * destination a USER chose, from a process that can reach the database, the other services on the
 * box and — on any cloud host — the metadata endpoint that hands out credentials to whoever asks.
 * The guard is what stops that being a "fetch any URL for me" primitive, so it is the one piece of
 * this feature that must not be wrong, and it gets its own file of assertions rather than a couple
 * of lines inside a scenario about something else.
 *
 * IT RUNS IN PROCESS, NOT OVER HTTP, and that is deliberate. Every case below is a single function
 * call against the real exported guard, so a case is cheap enough that the table can be exhaustive:
 * forty-odd spellings, each named, rather than the three or four a shell suite would tolerate. The
 * end-to-end half — an outbox row that really dies because its host resolves to loopback — is
 * asserted through the API in guard-check.sh, where it belongs.
 *
 * It prints one "  PASS | …" / "  FAIL | …" line per case, the same shape guard-check.sh's own `ok`
 * prints, so smoke.sh folds these into its totals without knowing this file exists.
 */
import {
  classifyAddress,
  postGuarded,
  PUBLIC_ONLY,
  validateWebhookUrl,
  WebhookRefusedError,
} from "../src/modules/workflow/webhook-url.js";

let failures = 0;
const ok = (condition: boolean, what: string, got?: string) => {
  if (condition) console.log(`  PASS | ${what}`);
  else {
    failures++;
    console.log(`  FAIL | ${what}${got ? `  (got '${got}')` : ""}`);
  }
};

// ── 1. the scheme allowlist ─────────────────────────────────────────────────────────────────────
// One entry. http is refused as firmly as gopher: the body carries the record's identity and the
// signature that authenticates it, and neither belongs on the wire in clear.
for (const [url, label] of [
  ["http://example.com/hook", "plain http"],
  ["file:///etc/passwd", "file://"],
  ["gopher://example.com/1", "gopher://"],
  ["ftp://example.com/x", "ftp://"],
  ["data:text/plain,hello", "a data: URI"],
  ["ws://example.com/socket", "ws://"],
  ["jar:https://example.com/a!/b", "a jar: wrapper around an https URL"],
] as const) {
  const v = validateWebhookUrl(url);
  ok(!v.ok, `SSRF: ${label} is refused as a webhook destination`);
}
ok(validateWebhookUrl("https://example.com/hook").ok, "SSRF: an ordinary https destination is allowed");

// ── 2. the many spellings of 127.0.0.1 ──────────────────────────────────────────────────────────
// The WHATWG URL parser rewrites the legacy IPv4 forms before we ever see the host, which is
// exactly why the guard is written against the PARSED address and not against the text somebody
// typed. Each of these is a real bypass against a string comparison.
for (const [url, label] of [
  ["https://127.0.0.1/hook", "127.0.0.1"],
  ["https://0x7f.1/hook", "the hex form 0x7f.1"],
  ["https://2130706433/hook", "the integer form 2130706433"],
  ["https://127.1/hook", "the short form 127.1"],
  ["https://0177.0.0.1/hook", "the octal-looking form 0177.0.0.1"],
  ["https://[::1]/hook", "the IPv6 form [::1]"],
  ["https://[::ffff:127.0.0.1]/hook", "the IPv4-mapped form [::ffff:127.0.0.1]"],
  ["https://[::ffff:7f00:1]/hook", "the same address written [::ffff:7f00:1]"],
  ["https://[64:ff9b::127.0.0.1]/hook", "the NAT64 form [64:ff9b::127.0.0.1]"],
  ["https://0/hook", "0, which is 0.0.0.0"],
  ["https://[::]/hook", "the unspecified address [::]"],
  ["https://127.0.0.1:8443/hook", "loopback on a non-default port"],
] as const) {
  const v = validateWebhookUrl(url);
  ok(!v.ok, `SSRF: ${label} is refused`, v.ok ? "allowed" : undefined);
}

// ── 3. the cloud metadata endpoint, by name ─────────────────────────────────────────────────────
// It is inside 169.254.0.0/16 and would be refused by the range check anyway. What is asserted here
// is that the refusal SAYS SO, because "169.254.0.0/16" and "the address that hands out this
// server's IAM credentials" are the same fact told at two very different volumes.
{
  const v = validateWebhookUrl("https://169.254.169.254/latest/meta-data/iam/security-credentials/");
  ok(!v.ok, "SSRF: the cloud metadata address 169.254.169.254 is refused");
  ok(!v.ok && /metadata/i.test(v.reason), "SSRF: and the refusal names it as the metadata service", v.ok ? "allowed" : v.reason);
  const v6 = validateWebhookUrl("https://[fe80::a9fe:a9fe]/latest/meta-data/");
  ok(!v6.ok && /metadata/i.test(v6.reason), "SSRF: its IPv6 address fe80::a9fe:a9fe is refused too");
}

// ── 4. everything else that is not the public internet ──────────────────────────────────────────
for (const [url, label] of [
  ["https://10.0.0.1/h", "RFC 1918 10/8"],
  ["https://172.16.0.1/h", "RFC 1918 172.16/12 at its low edge"],
  ["https://172.31.255.254/h", "RFC 1918 172.16/12 at its high edge"],
  ["https://192.168.1.1/h", "RFC 1918 192.168/16"],
  ["https://100.64.0.1/h", "carrier-grade NAT space"],
  ["https://169.254.1.1/h", "link-local space"],
  ["https://192.0.0.1/h", "IETF protocol assignment space"],
  ["https://192.0.2.5/h", "TEST-NET-1"],
  ["https://198.51.100.5/h", "TEST-NET-2"],
  ["https://203.0.113.5/h", "TEST-NET-3"],
  ["https://198.18.0.1/h", "benchmarking space"],
  ["https://192.88.99.1/h", "the deprecated 6to4 relay range"],
  ["https://224.0.0.1/h", "IPv4 multicast"],
  ["https://239.255.255.250/h", "SSDP multicast"],
  ["https://255.255.255.255/h", "the broadcast address"],
  ["https://[fd00::1]/h", "IPv6 unique-local space"],
  ["https://[fe80::1]/h", "IPv6 link-local space"],
  ["https://[ff02::1]/h", "IPv6 multicast"],
  ["https://[2001:db8::1]/h", "IPv6 documentation space"],
  ["https://[3fff::1]/h", "the newer IPv6 documentation space"],
  ["https://[2002:7f00:1::1]/h", "6to4 space, which tunnels to an embedded IPv4 address"],
  ["https://[2001::1]/h", "Teredo space, which does the same"],
  ["https://[100::1]/h", "the IPv6 discard-only range"],
  ["https://[2001:10::1]/h", "ORCHID space"],
  ["https://[5f00::1]/h", "an IPv6 range outside global unicast"],
  ["https://[fec0::1]/h", "deprecated IPv6 site-local space"],
] as const) {
  const v = validateWebhookUrl(url);
  ok(!v.ok, `SSRF: ${label} is refused`, v.ok ? "allowed" : undefined);
}

// ── 5. what must still work ─────────────────────────────────────────────────────────────────────
// A guard that refuses everything is not a guard, it is an outage. These are the addresses a real
// receiver lives on, and every one of them has to survive the rules above.
for (const [url, label] of [
  ["https://hooks.example.com/qvm", "an ordinary hostname"],
  ["https://hooks.example.co.uk:8443/a/b?c=d", "a hostname on a non-default port with a query"],
  ["https://1.1.1.1/h", "a public IPv4 literal"],
  ["https://8.8.8.8/h", "another public IPv4 literal"],
  ["https://[2606:4700:4700::1111]/h", "a public IPv6 literal"],
  ["https://[2001:4860:4860::8888]/h", "another public IPv6 literal"],
] as const) {
  const v = validateWebhookUrl(url);
  ok(v.ok, `SSRF: ${label} is allowed`, v.ok ? undefined : v.reason);
}

// ── 6. the rest of the URL, not just its host ───────────────────────────────────────────────────
{
  const creds = validateWebhookUrl("https://user:secret@hooks.example.com/qvm");
  ok(!creds.ok, "SSRF: a destination carrying a username and password is refused");
  const frag = validateWebhookUrl("https://hooks.example.com/qvm#part");
  ok(!frag.ok, "SSRF: a destination carrying a #fragment is refused rather than silently trimmed");
  ok(!validateWebhookUrl("").ok, "SSRF: an empty destination is refused");
  ok(!validateWebhookUrl("   ").ok, "SSRF: a blank destination is refused");
  ok(!validateWebhookUrl("hooks.example.com/qvm").ok, "SSRF: a bare host with no scheme is refused");
  ok(
    !validateWebhookUrl(`https://hooks.example.com/${"a".repeat(4000)}`).ok,
    "SSRF: a destination longer than the column can hold is refused before it is stored",
  );
}

// ── 7. the resolver's own output, which is what the send path actually classifies ───────────────
// makeGuardedLookup hands classifyAddress canonical strings from getaddrinfo, never user text. This
// is that layer on its own.
for (const [address, label] of [
  ["127.0.0.1", "loopback"],
  ["::1", "IPv6 loopback"],
  ["169.254.169.254", "the metadata endpoint"],
  ["::ffff:169.254.169.254", "the metadata endpoint reached IPv4-mapped"],
  ["64:ff9b::169.254.169.254", "the metadata endpoint reached through NAT64"],
  ["10.1.2.3", "private space"],
  ["fd12:3456::1", "unique-local space"],
  ["not-an-address", "a string that is not an address at all"],
] as const) {
  const v = classifyAddress(address);
  ok(!v.ok, `SSRF: a resolver answer of ${label} is refused`, v.ok ? "allowed" : undefined);
}
for (const [address, label] of [["93.184.216.34", "a public IPv4"], ["2606:4700::1111", "a public IPv6"]] as const) {
  const v = classifyAddress(address);
  ok(v.ok, `SSRF: a resolver answer of ${label} is allowed`, v.ok ? undefined : v.reason);
}

// ── 8. DNS REBINDING — the reason the check is at send time and not at save time ────────────────
// A NAME cannot be judged from its spelling. `some-customer.example` may answer publicly today and
// with 127.0.0.1 tomorrow, and nothing about the string says so — only the resolver knows, and only
// at the moment a socket is about to be opened. That is why configuration-time validation can never
// be the authority here, however thorough it looks.
//
// `localhost` and its family ARE refused by name, because they cannot legitimately be a customer's
// webhook and catching them while the admin is still looking at the screen is worth the two lines it
// costs. That is a courtesy, not the defence: the assertions below are the defence, and they hold
// for every name the list does not know.
{
  ok(
    !validateWebhookUrl("https://localhost/hook").ok,
    "SSRF: the name localhost is refused outright — it can never be a customer's endpoint",
  );
  ok(
    validateWebhookUrl("https://some-customer.example/hook").ok,
    "SSRF: an ordinary hostname passes configuration — its spelling says nothing about where it points",
  );
  let refusal = "";
  try {
    await postGuarded(new URL("https://localhost/hook"), "{}", {}, PUBLIC_ONLY);
  } catch (e) {
    refusal = `${(e as Error).name}: ${(e as Error).message}`;
  }
  ok(
    refusal.startsWith("WebhookRefusedError"),
    "SSRF: and IS refused at send time, once the resolver has been asked (this is the rebinding defence)",
    refusal || "the request was NOT refused",
  );
  ok(
    /127\.0\.0\.1|::1/.test(refusal),
    "SSRF: the refusal names the address it resolved to, not the name that was configured",
    refusal,
  );
  ok(
    refusal.includes("localhost"),
    "SSRF: and names the host that was asked for, so a reader can find the flow that configured it",
    refusal,
  );
}

// ── 9. A LITERAL ADDRESS AT SEND TIME, WHICH THE RESOLVER GUARD NEVER SEES ──────────────────────
// net.connect calls `lookup` only when it has a NAME to resolve; given an IP literal it skips
// resolution and opens the socket. So makeGuardedLookup — the defence the rest of this file is
// about — is not on the code path for https://169.254.169.254/ at all. That was a real hole: the
// connection to loopback was demonstrably established. postGuarded now classifies a literal host
// itself, and these are the cases that keep it doing so.
for (const [host, label] of [
  ["169.254.169.254", "the cloud metadata address"],
  ["127.0.0.1", "loopback"],
  ["[::1]", "IPv6 loopback"],
  ["10.0.0.1", "private space"],
] as const) {
  let name = "";
  try {
    await postGuarded(new URL(`https://${host}/hook`), "{}", {}, PUBLIC_ONLY);
  } catch (e) {
    name = (e as Error).name;
  }
  ok(
    name === "WebhookRefusedError",
    `SSRF: a request to the LITERAL address ${label} is refused by the sender itself`,
    name || "the request was NOT refused",
  );
}

// A destination that resolves to nothing at all is a transport failure, not a refusal — the two are
// different sentences in the run log because they need different people to fix them.
{
  let name = "";
  try {
    await postGuarded(new URL("https://qvm-webhook-guard.invalid/hook"), "{}", {}, PUBLIC_ONLY);
  } catch (e) {
    name = (e as Error).name;
  }
  ok(
    name !== "" && name !== "WebhookRefusedError",
    "SSRF: a name that does not resolve fails as a transport error, not as a refused destination",
    name,
  );
}

if (failures) process.exit(1);
