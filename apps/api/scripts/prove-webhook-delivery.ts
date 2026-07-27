/**
 * prove-webhook-delivery.ts — the test that belongs to the SEND half of the webhook action.
 *
 * prove-ssrf-guard.ts asserts what the guard REFUSES, forty-odd spellings at a time, without ever
 * opening a socket. This file asserts the opposite half, and it cannot be done without one: that a
 * real HTTP request really leaves this process, carries the bytes we think it carries, and is signed
 * in a way the receiver documented in migration 0064 can actually verify.
 *
 * ── WHY A REAL LISTENER AND NOT A MOCK ──────────────────────────────────────────────────────────
 * "The outbox row moved to 'delivered'" is a claim about a column. It stays true if the signature is
 * computed over the wrong bytes, if the headers are misspelled, if the body is re-serialised between
 * signing and sending, or if the receiver could never verify any of it — every one of which is a
 * real bug that ships silently and is only ever found by whoever writes the receiving end, weeks
 * later, with nothing to debug against. So this file stands up an actual HTTPS server on loopback,
 * sends to it with the actual send path, and verifies the captured raw body with the actual verifier
 * a receiver would use.
 *
 * ── WHY THE POLICY IS LOOSE HERE, AND WHY THAT IS NOT A HOLE ────────────────────────────────────
 * A listener a test machine can reach is on loopback, and the shipped guard refuses loopback — that
 * is the entire point of it. AddressPolicy exists so this file can say so out loud rather than the
 * guard growing an environment variable that a staging box sets and production inherits. Two things
 * keep the loose policy honest, and both are asserted rather than asserted-about:
 *   • case 9 below points the SHIPPED policy at this very listener and proves it is refused;
 *   • case 11 runs the SHIPPED dispatcher at the same listener and proves not one byte arrives;
 *   • and guard-check.sh greps src/ for `allowLoopback: true`, which must appear ZERO times.
 *
 * Prints one "  PASS | …" / "  FAIL | …" line per case, the shape guard-check.sh folds into its
 * totals. Requires openssl on PATH for a throwaway certificate — it is a hard requirement rather
 * than a skip, because a test that quietly does not run is worse than one that is missing.
 */
import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { DbService } from "../src/db/db.service.js";
import {
  MAX_ATTEMPTS,
  signDelivery,
  verifyDelivery,
  WorkflowWebhookDispatchService,
} from "../src/modules/workflow/webhook-dispatch.service.js";
import {
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

/** Loopback and a self-signed certificate. See the header for why this exists and what stops it
 *  being a way to reach loopback from anything that ships. */
const TEST_ONLY = { allowLoopback: true, trustAnyCertificate: true };

// ── a throwaway certificate ─────────────────────────────────────────────────────────────────────
// Generated per run into a temp directory and deleted at the end. Never committed, never reused:
// a key checked into a repository is a key on every developer's disk and in every clone forever.
const certDir = mkdtempSync(join(tmpdir(), "qvm-webhook-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(certDir, "key.pem"),
  "-out", join(certDir, "cert.pem"),
  "-days", "1", "-subj", "/CN=localhost",
], { stdio: "ignore" });

// ── the receiver ────────────────────────────────────────────────────────────────────────────────
interface Seen {
  path: string;
  method: string;
  headers: Record<string, string | undefined>;
  /** THE RAW BYTES, kept as they arrived. A receiver verifies against these; re-serialising the
   *  parsed JSON here would make the test agree with itself while a real receiver failed. */
  body: string;
}
const seen: Seen[] = [];
const at = (path: string) => seen.filter((r) => r.path === path);

const server = https.createServer(
  { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      seen.push({
        path,
        method: req.method ?? "",
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      // A receiver that never answers. Used to prove the idle timeout is real; answering it would
      // make the timer untestable and the dispatcher slot unbounded in production.
      if (path === "/silent") return;
      if (path === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("x".repeat(1024 * 1024));
      }
      if (path === "/redirect") {
        // The attack postGuarded's header describes: hop one is a destination that passed every
        // check, hop two is the credential vending machine.
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end("moved");
      }
      if (path === "/boom") {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("the receiver is unwell");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  },
);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = (server.address() as AddressInfo).port;
const base = `https://127.0.0.1:${PORT}`;
const SECRET = "a".repeat(64);

// ── 1. a real request, really sent ──────────────────────────────────────────────────────────────
const deliveryId = "11111111-2222-3333-4444-555555555555";
const payload = { delivery: deliveryId, event: "workflow.transition", record: { reference: "R-1" } };
{
  const { body, headers } = signDelivery(SECRET, deliveryId, payload);
  const response = await postGuarded(new URL(`${base}/hook`), body, headers, TEST_ONLY);
  ok(response.status === 200, "DELIVERY: a signed POST reaches a real listener over TLS", String(response.status));
  ok(at("/hook").length === 1, `DELIVERY: exactly one request arrived`, String(at("/hook").length));
  ok(at("/hook")[0]?.method === "POST", "DELIVERY: it is a POST", at("/hook")[0]?.method);
  ok(
    at("/hook")[0]?.headers["content-type"] === "application/json",
    "DELIVERY: it declares itself as JSON",
    at("/hook")[0]?.headers["content-type"],
  );
}

// ── 2. the signature verifies AT THE RECEIVER, over the bytes the receiver actually read ────────
// This is the assertion the whole file exists for. verifyDelivery is the code migration 0064's
// scheme tells a third party to write, run here against a body that has been through a socket.
const arrived = at("/hook")[0];
{
  const verdict = verifyDelivery(SECRET, arrived.body, arrived.headers);
  ok(verdict.ok, "SIGNING: the receiver can verify the signature over the raw body it read",
    verdict.ok ? undefined : verdict.reason);
  ok(
    arrived.headers["x-qvm-delivery"] === deliveryId,
    "SIGNING: the delivery id is on the request, so a receiver can de-duplicate retries",
    arrived.headers["x-qvm-delivery"],
  );
  // Only the body is covered by the HMAC. A receiver that de-duplicated on the HEADER would be
  // de-duplicating on a value nobody authenticated, which is how a replay becomes a new event.
  ok(
    (JSON.parse(arrived.body) as { delivery: string }).delivery === deliveryId,
    "SIGNING: and inside the SIGNED body too, which is the copy a receiver may trust",
  );
}

// ── 3. what the signature is actually binding ───────────────────────────────────────────────────
{
  const tampered = arrived.body.replace("R-1", "R-2");
  ok(
    tampered !== arrived.body && !verifyDelivery(SECRET, tampered, arrived.headers).ok,
    "SIGNING: one changed character in the body breaks verification",
  );
  ok(
    !verifyDelivery("b".repeat(64), arrived.body, arrived.headers).ok,
    "SIGNING: a different secret does not verify — the URL alone is not enough to forge a call",
  );
  // The timestamp is INSIDE the signed message, not merely beside it. If it were only a header, a
  // captured request could be replayed with any timestamp and still verify, so the freshness check
  // would be checking a number nobody had authenticated.
  const moved = { ...arrived.headers, "x-qvm-timestamp": String(Number(arrived.headers["x-qvm-timestamp"]) + 1) };
  const verdict = verifyDelivery(SECRET, arrived.body, moved);
  ok(
    !verdict.ok && verdict.reason.includes("does not match"),
    "SIGNING: moving the timestamp by one second breaks the signature — the two are bound together",
    verdict.ok ? "verified" : verdict.reason,
  );
  // And the freshness check itself, which is what stops a captured request being a permanent licence.
  const old = signDelivery(SECRET, deliveryId, payload, Date.now() - 3_600_000);
  const replay = verifyDelivery(SECRET, old.body, old.headers);
  ok(
    !replay.ok && replay.reason.includes("away from now"),
    "SIGNING: an hour-old capture is refused as stale, so a signature is not valid forever",
    replay.ok ? "verified" : replay.reason,
  );
}

// ── 4. the response body is capped ──────────────────────────────────────────────────────────────
// A receiver answering with a two-gigabyte stack trace must cost us eight kilobytes and a closed
// socket, not our memory.
{
  const { body, headers } = signDelivery(SECRET, deliveryId, payload);
  const response = await postGuarded(new URL(`${base}/big`), body, headers, TEST_ONLY);
  ok(
    response.body.length <= 8 * 1024,
    "DELIVERY: a one-megabyte reply is read up to the cap and no further",
    `${response.body.length} bytes`,
  );
}

// ── 5. redirects are NOT followed ───────────────────────────────────────────────────────────────
// The bypass that defeats a guard which only ever looked at the first URL.
{
  const { body, headers } = signDelivery(SECRET, deliveryId, payload);
  const response = await postGuarded(new URL(`${base}/redirect`), body, headers, TEST_ONLY);
  ok(response.status === 302, "DELIVERY: a 302 is returned as a 302, not chased", String(response.status));
  ok(
    !/ami-id|instance-id|iam/i.test(response.body),
    "DELIVERY: and a redirect to the cloud metadata endpoint therefore fetches nothing",
  );
}

// ── 6. a receiver that answers badly is a failure, not a delivery ───────────────────────────────
{
  const { body, headers } = signDelivery(SECRET, deliveryId, payload);
  const response = await postGuarded(new URL(`${base}/boom`), body, headers, TEST_ONLY);
  ok(response.status === 500, "DELIVERY: a 500 comes back as 500 for the run log to record", String(response.status));
}

// ── 7. a receiver that never answers is bounded ─────────────────────────────────────────────────
{
  const started = Date.now();
  let message = "";
  try {
    const { body, headers } = signDelivery(SECRET, deliveryId, payload);
    await postGuarded(new URL(`${base}/silent`), body, headers, TEST_ONLY);
  } catch (e) {
    message = (e as Error).message;
  }
  ok(message.includes("no response within"), "DELIVERY: a receiver that never replies trips the idle timeout", message);
  ok(
    Date.now() - started < 9_000,
    "DELIVERY: and does so in seconds, so one bad receiver cannot hold a dispatcher slot",
    `${Date.now() - started}ms`,
  );
}

// ── 8. the loose policy is the ONLY reason any of the above reached loopback ─────────────────────
const before = seen.length;
{
  const verdict = validateWebhookUrl(`${base}/hook`, PUBLIC_ONLY);
  ok(!verdict.ok, "SSRF: the shipped policy refuses this very listener at configuration time");

  let name = "";
  try {
    const { body, headers } = signDelivery(SECRET, deliveryId, payload);
    await postGuarded(new URL(`${base}/hook`), body, headers, PUBLIC_ONLY);
  } catch (e) {
    name = (e as Error).name;
  }
  ok(name === WebhookRefusedError.name, "SSRF: and refuses it at send time as well", name || "no error was raised");
  ok(seen.length === before, "SSRF: not one byte reached the listener under the shipped policy",
    `${seen.length - before} requests arrived`);
}

// ── 9. THE SHIPPED DISPATCHER, END TO END, AT A LISTENER THAT IS REALLY THERE ───────────────────
// Everything above tests the send path directly. This tests the thing that ships: a row in the
// outbox, claimed and attempted by WorkflowWebhookDispatchService itself, with no policy argument
// anywhere in reach. The listener is running and would answer 200 — and must never be asked.
const db = new DbService();
const ENTITY = "00000000-0000-4000-8000-0000000000aa";
const [tenant] = (await db.withContext(
  { tenantId: null, userId: null, isInternal: false },
  (tx) => tx.execute(sql`select id from tenants where slug = 'riyadh'`),
)) as Array<{ id: string }>;
try {
  await db.withContext(
    { tenantId: tenant.id, userId: null, isInternal: false, environment: "live" },
    (tx) => tx.execute(sql`
      insert into workflow_webhook_outbox
        (tenant_id, environment, entity_type, entity_id, transition_key, url, payload)
      values (${tenant.id}::uuid, 'live', 'rfq', ${ENTITY}::uuid, 'a>b',
              ${`${base}/hook`}, ${JSON.stringify(payload)}::jsonb)`),
  );

  const arrivedBefore = seen.length;
  await new WorkflowWebhookDispatchService(db).runOnce();

  const [row] = (await db.withContext(
    { tenantId: tenant.id, userId: null, isInternal: false, environment: "live" },
    (tx) => tx.execute(sql`
      select status, attempts, coalesce(last_error, '') as last_error
      from workflow_webhook_outbox where entity_id = ${ENTITY}::uuid`),
  )) as Array<{ status: string; attempts: number; last_error: string }>;

  ok(seen.length === arrivedBefore,
    "SSRF: the SHIPPED dispatcher does not reach a loopback listener that is sitting there answering",
    `${seen.length - arrivedBefore} requests arrived`);
  // `>= 1` rather than `= 1`: the running API has its own ticker, and either process claiming this
  // row runs the same shipped code. What is being asserted is the refusal, not which process made it.
  ok(Number(row?.attempts) >= 1, "SSRF: it attempted the row rather than skipping it", String(row?.attempts));
  ok(row?.status === "pending" && Number(row?.attempts) < MAX_ATTEMPTS,
    "SSRF: and left it to be retried rather than killing it on the first refusal", row?.status);
  ok(/refused/.test(row?.last_error ?? ""), "SSRF: recorded as a refusal, not as an unreachable host",
    row?.last_error);
  ok(/127\.0\.0\.1/.test(row?.last_error ?? ""), "SSRF: naming the address it would not call",
    row?.last_error);
} finally {
  // Leave nothing behind: the suite that runs this asserts exact outbox counts a few checks later.
  await db.withContext(
    { tenantId: tenant.id, userId: null, isInternal: false, environment: "live" },
    (tx) => tx.execute(sql`delete from workflow_webhook_outbox where entity_id = ${ENTITY}::uuid`),
  );
  await db.onModuleDestroy();
}

server.closeAllConnections?.();
await new Promise<void>((resolve) => server.close(() => resolve()));
rmSync(certDir, { recursive: true, force: true });

if (failures) process.exit(1);
