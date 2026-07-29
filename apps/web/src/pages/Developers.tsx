import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  Code2,
  Copy,
  Globe2,
  KeyRound,
  Link2,
  ListTree,
  Plug,
  Rocket,
  ShieldAlert,
  Terminal,
  TriangleAlert,
  Webhook,
} from "lucide-react";

/**
 * DEVELOPERS — what somebody outside this company needs in order to connect their system to ours.
 *
 * THE RULE THIS PAGE IS WRITTEN UNDER. Every endpoint, header, field, status code and example below
 * was run against the API before it was written down, or read out of the source and labelled as
 * such. Documentation that describes an endpoint we do not have is worse than no documentation at
 * all, because the person acting on it is a developer at a customer who will build against it and
 * find out in their integration test — or in production. When the code and this page disagreed
 * while it was being written, the page changed. Nothing here was ever fixed by changing the API.
 *
 * WHAT THAT COSTS. A quantity of this page is about what we cannot do yet, and the biggest item is
 * the first thing anybody reads: there are no API keys. Integrating today means holding a real
 * user's password. That is not a comfortable sentence to publish, and publishing it is the whole
 * point — an integrator who discovers it themselves has already written the wrong client, and an
 * integrator who is told it up front can decide whether to wait for us. The same applies to the
 * missing pagination, the missing token refresh, and the fact that a sandbox webhook really does
 * call your server. See "What is not available yet"; it is a section, not a footnote.
 *
 * WHY IT IS A PAGE IN THE PRODUCT rather than a README. It is served from the same deployment as
 * the API it documents, so the two ship together and cannot drift apart in a release. It is public:
 * no session, no workspace, no account — the reader is at another company and has none of those.
 *
 * ONE SECTION IS NOT LIVE. The MCP server is documented ahead of itself, and says so in its own
 * heading and first line — including the exact failure a client hits today, which is not a refused
 * connection but a 200 of this very page, because /mcp falls through to the SPA catch-all. That is the only forward-looking section on the page; everything else
 * answers today.
 */

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The section spine. The table of contents renders from this array and each section registers its
   own heading against it, so a section can never exist that the contents does not list, or vice
   versa.
   ──────────────────────────────────────────────────────────────────────────────────────────── */
const SECTIONS = [
  { id: "getting-started", label: "Getting started", icon: Rocket },
  { id: "authentication", label: "Authentication", icon: KeyRound },
  { id: "environments", label: "Environments & headers", icon: Globe2 },
  { id: "requests", label: "Making requests", icon: Terminal },
  { id: "resources", label: "Core resources", icon: Boxes },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "quote-links", label: "Vendor quote links", icon: Link2 },
  { id: "mcp", label: "MCP server", icon: Plug },
  { id: "errors", label: "Errors", icon: TriangleAlert },
  { id: "limits", label: "Limits", icon: ListTree },
  { id: "gaps", label: "What is not available yet", icon: ShieldAlert },
] as const;

/**
 * The origin an integrator should call, worked out from where this app is being served.
 *
 * IT DELIBERATELY RESOLVES TO THE APEX, NOT TO THE CURRENT HOST. A workspace subdomain OUTRANKS the
 * X-Tenant header (see resolveTenantSlug in the API), so an example built from
 * `riyadh.easycarty.store` would carry an X-Tenant that is silently ignored — the reader would copy
 * a request whose most important header does nothing, and only find out when they pointed it at a
 * different workspace. Stripping back to the apex makes the header in every example the thing that
 * actually decides.
 */
/**
 * THE ONE ADDRESS THIS PAGE DOCUMENTS.
 *
 * It used to be derived from `window.location`, which is right for a page our own engineers read on
 * whatever host they happen to be on, and wrong for this one: an outside integrator reading it on a
 * staging mirror, or a colleague who opened it on localhost and pasted a snippet into an email,
 * would hand a customer a base URL that answers on nobody's machine but their own. The public API
 * has one address, so the page states it rather than guessing it.
 */
const PUBLIC_API_BASE = "https://easycarty.store";

/** One copyable block. `label` names what it is so a reader scanning for "the Python one" finds it. */
function Code({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access is refused over plain http and in some embedded browsers. Saying so beats
      // a button that looks like it worked.
      setCopied(false);
      window.prompt("Copy this", code);
    }
  }, [code]);

  return (
    <div className="group relative mt-2 overflow-hidden rounded-xl2 border border-line bg-surface">
      {label && (
        <div className="flex items-center gap-2 border-b border-line-2 px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</span>
        </div>
      )}
      <button
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        className="btn btn-sm absolute right-2 z-10 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
        style={{ top: label ? 34 : 8 }}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto px-3 py-2.5 text-[12px] leading-[1.65] text-ink">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

/** Inline code — endpoints, headers, field names. */
function C({ children }: { children: ReactNode }) {
  return (
    // overflow-wrap:anywhere, not break-all: a long unbroken token (a quote-link URL) is the only
    // thing on this page that made the whole document scroll sideways on a phone. `anywhere` breaks
    // it only when it would otherwise overflow, so short tokens like X-Tenant stay on one line.
    <code className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[12px] text-ink [overflow-wrap:anywhere]">{children}</code>
  );
}

/** A callout. `warn` is for the things that cost money or leak data when misread. */
function Note({ tone = "info", title, children }: { tone?: "info" | "warn"; title?: string; children: ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      className={`mt-3 flex gap-2.5 rounded-xl2 border p-3 ${warn ? "border-[var(--chip-red-bg)] bg-[var(--chip-red-bg)]" : "border-line bg-surface"}`}>
      <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? "text-accent" : "text-faint"}`} />
      <div className="min-w-0 text-[12.5px] leading-relaxed text-sub">
        {title && <p className="font-medium text-ink">{title}</p>}
        {children}
      </div>
    </div>
  );
}

function Section({
  id, title, icon: Icon, lede, badge, children,
}: { id: string; title: string; icon: typeof Rocket; lede?: ReactNode; badge?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 border-t border-line pt-8 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="h-[18px] w-[18px] text-accent" />
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
        {badge && (
          <span className="rounded-full border border-line bg-[var(--panel-2)] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-faint">
            {badge}
          </span>
        )}
      </div>
      {lede && <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-sub">{lede}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mb-1.5 mt-6 text-[13.5px] font-semibold text-ink first:mt-0">{children}</h3>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-sub">{children}</p>;
}

/** A scrolling table wrapper — the endpoint tables are wider than a narrow window. */
function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="card mt-3 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>{head.map((h) => <th key={h} className="th">{h}</th>)}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

export default function Developers() {
  const base = PUBLIC_API_BASE;
  /**
   * PLACEHOLDERS, NOT THIS BROWSER'S VALUES.
   *
   * An earlier draft filled the examples in from the reader's own session — their workspace slug,
   * their current environment — which reads beautifully to one of us and is wrong for everybody
   * this page is written for. The reader is a developer at ANOTHER COMPANY. They have no session
   * here and no workspace of their own; they were issued a slug, an environment and credentials by
   * the QVM customer they are integrating with, and this page cannot know any of them. An example
   * pre-filled with somebody else's workspace is worse than a placeholder, because it looks
   * copy-pasteable and is not.
   */
  const tenant = "<your-workspace>";
  const env = "<live|sandbox>";
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  /**
   * Highlight the section being read.
   *
   * MEASURED EVERY TIME RATHER THAN CACHED. The obvious implementation — an IntersectionObserver
   * keeping each section's last reported ratio and picking the largest — is wrong here, and
   * observably so: sections on this page run from 700px to 4600px, and a jump (an anchor click, a
   * restored scroll position) can move past several of them inside one frame, which delivers fewer
   * entries than sections crossed and leaves a stale ratio winning. It highlighted "Making requests"
   * while Webhooks filled the screen.
   *
   * So the geometry is read at the moment it is needed. The active section is the LAST one that has
   * started above a reading line near the top of the viewport, which is also the only definition
   * that behaves when a section is taller than the window — "most visible" is meaningless then,
   * because the answer is the same section for four screenfuls.
   */
  useEffect(() => {
    const READING_LINE = 140; // just below the app header

    const pick = () => {
      const last = SECTIONS[SECTIONS.length - 1];
      let current: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= READING_LINE) current = s.id;
      }
      // At the very bottom no further section can cross the line, so the last one would never be
      // reachable if it is shorter than the gap. Once its end is on screen, it is what you are on.
      const tail = document.getElementById(last.id);
      if (tail && tail.getBoundingClientRect().bottom <= window.innerHeight + 2) current = last.id;
      setActive(current);
    };

    // Coalesce to one measurement per frame. CANCEL-AND-RESCHEDULE rather than "skip if one is
    // already pending": with the skip form, a frame that never arrives (a backgrounded tab throttles
    // rAF to zero) leaves the pending flag set for good and every later scroll is dropped silently.
    // Rescheduling cannot wedge — whenever a frame does arrive, it measures where the page is now.
    let frame = 0;
    const onScroll = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => { frame = 0; pick(); });
    };

    pick();
    // Capture phase: scroll does not bubble, and the scroller is AppShell's <main>, not the window.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };

  return (
    <div className="min-h-screen bg-panel">
      {/* ── Public header ─────────────────────────────────────────────────────────────────────
          This page is served OUTSIDE the application shell, so it inherits no branding at all. A
          reader arrives from a link somebody emailed them, with no account and no context: without
          this bar the first thing they see is the word "Developers" floating on a white page, with
          nothing saying whose API it documents or where to go if they turn out to have an account
          after all. */}
      <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[17px] font-bold tracking-tight text-accent">Q</span>
            <span className="text-[15px] font-semibold tracking-tight text-ink">PARTS</span>
            <span className="ml-1.5 rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              API docs
            </span>
          </div>
          <a href="/" className="text-[12.5px] text-muted transition hover:text-ink">
            Have an account? Sign in
          </a>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-5 py-6 lg:flex-row lg:items-start lg:gap-8">
      {/* ── Table of contents ─────────────────────────────────────────────────────────────── */}
      <nav className="shrink-0 lg:sticky lg:top-0 lg:w-56 lg:py-1">
        <p className="mb-2 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          On this page
        </p>
        <ul className="flex snap-x gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {SECTIONS.map((s) => {
            const on = active === s.id;
            return (
              <li key={s.id} className="snap-start">
                <a
                  href={`#${s.id}`}
                  onClick={go(s.id)}
                  className={`flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px] no-underline transition ${
                    on ? "bg-accent-50 font-medium text-accent" : "text-sub hover:bg-surface"
                  }`}>
                  <s.icon className="h-[15px] w-[15px] shrink-0" />
                  {s.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ── Content ───────────────────────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1">
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <Code2 className="h-5 w-5 text-accent" />
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">Developers</h1>
          </div>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
            For engineers outside QVM connecting their own system to a customer's workspace here: how
            to authenticate, how to address a workspace and an environment, the endpoints worth
            integrating against, and how to receive and verify our outbound webhooks. Every example on
            this page was run against a live API before it was published.
          </p>

          {/* Written first because every one of these comes from a person, not from an API, and an
              integrator who discovers that on day three has lost three days. */}
          <div className="mt-4 max-w-3xl rounded-lg border border-line bg-surface p-4">
            <p className="text-[13px] font-semibold text-ink">Before you write any code</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              Four things, and all four come from the QVM workspace you are integrating with — none of
              them can be obtained from this API:
            </p>
            <ol className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-sub">
              <li>
                <b className="font-medium text-ink">1. Credentials.</b> There is no API key yet, so
                they will issue you a normal user account. Your system signs in with it and holds the
                password — say so in your own security review before you start.
              </li>
              <li>
                <b className="font-medium text-ink">2. The workspace slug.</b> A short name like{" "}
                <C>riyadh</C>, sent on every request as <C>X-Tenant</C>.
              </li>
              <li>
                <b className="font-medium text-ink">3. Which environment.</b>{" "}
                <C>sandbox</C> while you build, <C>live</C> when you go live. They are fully separate
                sets of data; nothing you write in one is visible in the other.
              </li>
              <li>
                <b className="font-medium text-ink">4. The webhook signing secret</b> — only if you
                want to receive events. They generate it; you verify every delivery against it.
              </li>
            </ol>
          </div>
        </div>

        <div className="flex flex-col gap-8">
          {/* ── GETTING STARTED ───────────────────────────────────────────────────────────── */}
          <Section
            id="getting-started"
            title="Getting started"
            icon={Rocket}
            lede="A JSON REST API over HTTPS. There is no SDK and no OpenAPI document — the calls below are the interface.">
            <H3>Base URL</H3>
            <P>
              Every route lives under the <C>/api</C> prefix. There is no version segment: the API is
              not versioned today, which is worth knowing before you build against it (see{" "}
              <a href="#gaps" onClick={go("gaps")} className="text-accent no-underline hover:underline">
                what is not available yet
              </a>
              ).
            </P>
            {/* One row. `localhost` belonged to the draft written for our own engineers; to an
                outside integrator it is an address that answers on their own laptop and not here. */}
            <Table head={["Environment", "Base URL"]}>
              <tr className="trow">
                <td className="td">All requests</td>
                <td className="td font-mono text-[12px]">https://easycarty.store/api</td>
              </tr>
            </Table>
            <Note>
              A workspace also answers on its own subdomain (<C>{tenant}.easycarty.store</C>). Prefer the
              apex for API calls: a subdomain <b className="font-medium text-ink">outranks</b> the{" "}
              <C>X-Tenant</C> header, so calling a subdomain with a different <C>X-Tenant</C> silently
              ignores the header rather than failing.
            </Note>

            <H3>Three things every call needs</H3>
            <P>
              A bearer token, the workspace you are addressing, and the environment you are writing
              to. The examples below use <C>{tenant}</C> and <C>{env}</C> as placeholders —{" "}
              <b className="font-medium text-ink">replace both</b> with the values the workspace gave
              you. Getting the environment wrong is the quiet one: it does not error, it writes your
              data somewhere nobody is looking.
            </P>
            <Code
              label="1. Get a token"
              code={`curl -X POST ${base}/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"your-password"}'`}
            />
            <P>
              Returns <C>201 Created</C> — not <C>200</C>. Every successful <C>POST</C> in this API
              returns <C>201</C> unless stated otherwise.
            </P>
            <Code
              label="Response"
              code={`{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZWFmN2Nl…","user":{"id":"deaf7ce0-5ac6-4ab0-a0dc-9715fb84464b","fullName":"Platform Admin"}}`}
            />

            <Code
              label="2. Confirm what the server resolved"
              code={`curl ${base}/api/me \\
  -H "Authorization: Bearer $QVM_TOKEN" \\
  -H 'X-Tenant: ${tenant}' \\
  -H 'X-Environment: ${env}'`}
            />
            <P>
              Do this first, every time, in every environment. It is the only place the server tells
              you which workspace and which environment it actually applied — and the environment
              header fails open (see below), so it is the one call that can save you from writing test
              data into production.
            </P>
            <Code
              label="Response"
              code={`{
  "user": { "id": "deaf7ce0-…", "email": "admin@qparts.local", "full_name": "Platform Admin" },
  "tenant": { "slug": "${tenant}", "id": "9ee1d8c6-9a9d-4426-9d95-c67e1cfd185b" },
  "role": "super_admin",
  "environment": "${env}",
  "isInternal": true,
  "platformRole": "super_admin",
  "isVendor": false,
  "isWorkshop": false,
  "activationStatus": null,
  "counterpartyType": null,
  "persona": "platform",
  "impersonating": false,
  "impersonatorName": null
}`}
            />
          </Section>

          {/* ── AUTHENTICATION ────────────────────────────────────────────────────────────── */}
          <Section
            id="authentication"
            title="Authentication"
            icon={KeyRound}
            lede="A user's JSON Web Token is the only credential this API accepts. Read this section before you design your client — it constrains more than it looks like it does.">
            <Note tone="warn" title="There are no API keys.">
              No API keys, no service accounts, no OAuth, no client credentials, no signing keys for
              requests sent <i>to</i> us. The only way to authenticate is to log in as a real user with
              their email and password.{" "}
              <b className="font-medium text-ink">
                Integrating today means your system holds a person's password.
              </b>{" "}
              Everything below follows from that, and none of it is a workaround we can offer you
              instead.
            </Note>

            <H3>What that implies</H3>
            <ul className="mt-2 flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-sub">
              <li>
                <b className="font-medium text-ink">The token expires.</b> The default lifetime is one
                day. There is no refresh endpoint — the only way to get a new token is to log in again,
                so your client must keep the credentials, not just the token.
              </li>
              <li>
                <b className="font-medium text-ink">You cannot tell expiry from tampering.</b> An
                expired token, a token signed with the wrong key and a malformed string all return the
                same <C>401</C> with <C>invalid token</C>. Treat every <C>401</C> as "log in again".
              </li>
              <li>
                <b className="font-medium text-ink">
                  Deactivating the user kills the token immediately.
                </b>{" "}
                The guard re-reads the user from the database on every single request, so a token stops
                working mid-lifetime — you will get <C>401 user is deactivated</C> partway through a run
                rather than at the next expiry. This is the intended way to cut an integration off.
              </li>
              <li>
                <b className="font-medium text-ink">The token carries no workspace.</b> It identifies
                only the user. Which workspace a request touches is decided per request by the{" "}
                <C>X-Tenant</C> header.
              </li>
              <li>
                <b className="font-medium text-ink">The integration can do whatever that user can do.</b>{" "}
                There is no narrower scope, no read-only mode and no per-endpoint grant. Choose the
                account accordingly — give the integration a user with the least role that works.
              </li>
            </ul>

            <H3>Sending the token</H3>
            <Code code={`Authorization: Bearer <token>`} />
            <P>
              The prefix is matched exactly, including the capital B and the trailing space. A
              lowercase <C>bearer</C> is rejected with <C>401 missing bearer token</C>.
            </P>

            <H3>Endpoints that need no token</H3>
            <P>Exactly three routes in the API are unauthenticated:</P>
            <Table head={["Route", "What it is for"]}>
              <tr className="trow">
                <td className="td font-mono text-[12px]">POST /api/auth/login</td>
                <td className="td">Exchange email and password for a token.</td>
              </tr>
              <tr className="trow">
                <td className="td font-mono text-[12px]">POST /api/auth/signup</td>
                <td className="td">Self-registration for a vendor or workshop. Creates a pending account.</td>
              </tr>
              <tr className="trow">
                <td className="td font-mono text-[12px]">POST /api/quote-access/:token/quote</td>
                <td className="td">
                  A vendor answering a quote through a signed link.{" "}
                  <a href="#quote-links" onClick={go("quote-links")} className="text-accent no-underline hover:underline">
                    See below
                  </a>
                  .
                </td>
              </tr>
            </Table>
          </Section>

          {/* ── ENVIRONMENTS & HEADERS ────────────────────────────────────────────────────── */}
          <Section
            id="environments"
            title="Environments & headers"
            icon={Globe2}
            lede="Two headers decide which data a request can see. Getting either wrong is the most expensive mistake available on this API, so both fail loudly except one, which fails quietly — and that one is the dangerous one.">
            <H3>X-Tenant — which workspace</H3>
            <P>
              The workspace slug, for example <C>{tenant}</C>. Required by every route that reads or
              writes workspace data. Identity and directory routes (<C>/api/me</C>,{" "}
              <C>/api/workspaces</C>, <C>/api/vendors</C>, <C>/api/org/workshops</C>) work without it.
            </P>
            <Table head={["Situation", "Response"]}>
              <tr className="trow">
                <td className="td">Missing on a route that needs one</td>
                <td className="td font-mono text-[12px]">400 no workspace resolved (subdomain / X-Tenant)</td>
              </tr>
              <tr className="trow">
                <td className="td">Slug does not exist, or the workspace is inactive</td>
                <td className="td font-mono text-[12px]">403 unknown or inactive workspace</td>
              </tr>
              <tr className="trow">
                <td className="td">Real workspace, but this user has no access to it</td>
                <td className="td font-mono text-[12px]">403 no access to this workspace</td>
              </tr>
            </Table>
            <P>
              A workspace subdomain takes precedence over the header. On{" "}
              <C>{tenant}.easycarty.store</C> the workspace is <C>{tenant}</C> and <C>X-Tenant</C> is
              never consulted. The subdomains <C>www</C>, <C>app</C>, <C>api</C>, <C>admin</C>,{" "}
              <C>static</C> and <C>assets</C> are treated as the apex, so the header applies there.
            </P>

            <H3>X-Environment — live or sandbox</H3>
            <P>
              Two values: <C>live</C> and <C>sandbox</C>. Sandbox is a complete, separate copy of your
              workspace's data — separate records, separate order numbers (they carry an{" "}
              <C>SBX-</C> infix), separate webhook signing secret.
            </P>
            <Note tone="warn" title="The header fails open to live.">
              The value is trimmed and lowercased, then compared to <C>sandbox</C> — so{" "}
              <C>SANDBOX</C> and <C> sandbox </C> are fine.{" "}
              <b className="font-medium text-ink">Anything else at all is live</b>: a typo, a
              misspelling, a header your proxy stripped, an absent header. There is no error and no
              warning. Sending <C>X-Environment: Production</C> writes to real data and returns{" "}
              <C>200</C>. This is deliberate — a forgotten header can never widen access, only leave
              you where you already were — but it means a misconfigured client has no way of noticing
              on its own.
            </Note>
            <P>
              The only defence is to read the environment back. <C>GET /api/me</C> returns the
              environment the <i>server</i> resolved, not the one you believe you sent. Assert on it at
              startup.
            </P>
            <Code
              label="Prove which environment you are really in"
              code={`curl -s ${base}/api/me \\
  -H "Authorization: Bearer $QVM_TOKEN" \\
  -H 'X-Tenant: ${tenant}' \\
  -H 'X-Environment: sandbox' | grep -o '"environment":"[a-z]*"'

# "environment":"sandbox"`}
            />

            <H3>How the isolation is enforced</H3>
            <P>
              In the database, as a restrictive row-level policy — not in application code. A request
              in one environment cannot read, write or join to a row in the other, whatever the query
              does. Reaching for a record from the wrong environment returns{" "}
              <C>404 ... not found in this workspace</C>, never <C>403</C>: a 403 would confirm the
              record exists, which would let a sandbox session enumerate real document ids.
            </P>
            <Code
              label="The same list, both environments"
              code={`curl -s ${base}/api/rfqs -H "Authorization: Bearer $QVM_TOKEN" \\
  -H 'X-Tenant: ${tenant}' -H 'X-Environment: live'
# {"count":1,"rfqs":[{"id":"f6fa3d11-…","order_number":"RYD-1","plate_number":"ABC-1234","status":"Confirmed","items":1}]}

curl -s ${base}/api/rfqs -H "Authorization: Bearer $QVM_TOKEN" \\
  -H 'X-Tenant: ${tenant}' -H 'X-Environment: sandbox'
# {"count":1,"rfqs":[{"id":"522abc10-…","order_number":"CEN-SBX-1","plate_number":"DOC-1234","status":"New RFQ","items":1}]}`}
            />

            <H3>What sandbox does and does not suppress</H3>
            <P>
              Notifications aimed at a vendor or a workshop are recorded as <C>suppressed</C> in
              sandbox rather than dispatched. Two caveats matter more than the rule:
            </P>
            <ul className="mt-2 flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-[13px] leading-relaxed text-sub">
              <li>
                <b className="font-medium text-ink">No environment sends email or WhatsApp today.</b>{" "}
                The provider dispatch is not implemented; the notification log records intent, not
                delivery. Do not build a flow that depends on a vendor receiving a message from us.
              </li>
              <li>
                <b className="font-medium text-ink">
                  Sandbox webhooks are real outbound HTTP requests.
                </b>{" "}
                Workflow webhooks do not go through the notification layer and are{" "}
                <b className="font-medium text-ink">not</b> suppressed in sandbox — the dispatcher runs
                a pass for both environments. A sandbox flow pointed at your production receiver will
                call your production receiver. Point it at a test endpoint.
              </li>
            </ul>
          </Section>

          {/* ── MAKING REQUESTS ───────────────────────────────────────────────────────────── */}
          <Section
            id="requests"
            title="Making requests"
            icon={Terminal}
            lede="JSON in, JSON out. A few conventions here are not the defaults you may expect.">
            <Table head={["", ""]}>
              <tr className="trow">
                <td className="td w-52 align-top font-medium">Content type</td>
                <td className="td">
                  <C>Content-Type: application/json</C> is required on any request with a body. Without
                  it the body is not parsed and you get a validation error listing every field as
                  missing — which reads like a bad payload rather than a bad header.
                </td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Success codes</td>
                <td className="td">
                  <C>GET</C> returns <C>200</C>. <C>POST</C> returns <C>201</C>, including for actions
                  that are not creations (<C>/api/auth/login</C> returns <C>201</C>).
                </td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Request body size</td>
                <td className="td">
                  100 KB. A larger body is refused with <C>413</C> and the body{" "}
                  <C>{`{"statusCode":413,"message":"request entity too large"}`}</C> — note it has no{" "}
                  <C>error</C> key, unlike other failures.
                </td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">CORS</td>
                <td className="td">
                  Open to every origin, with credentials disabled. Browser-side calls work; the token
                  must be attached by your own code, not by a cookie.
                </td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Timestamps</td>
                <td className="td">
                  Not uniform. <C>/api/workflow/run-log</C> and webhook payloads return ISO-8601 with a{" "}
                  <C>Z</C> (<C>2026-07-29T05:12:44.117Z</C>). Most other endpoints return the Postgres
                  form (<C>2026-07-27 18:38:32.09884+00</C>). Parse defensively.
                </td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Money</td>
                <td className="td">
                  Returned as a decimal <i>string</i> (<C>"130.00"</C>), not a number. Do not parse it
                  into a float before you round it.
                </td>
              </tr>
            </Table>

            <H3>Pagination</H3>
            <Note tone="warn" title="There is none.">
              No endpoint in this API accepts <C>offset</C>, <C>cursor</C>, <C>page</C> or{" "}
              <C>after</C>. List endpoints either cap the result in SQL — in which case rows past the
              cap are <b className="font-medium text-ink">not reachable through the API at all</b> — or
              accept a <C>limit</C> and nothing else. Design your sync around this: it is a full
              re-read of the head of a list, not a walk through history.
            </Note>
            <Table head={["Endpoint", "Cap", "Client-settable"]}>
              {[
                ["GET /api/rfqs", "50 (fixed)", "no"],
                ["GET /api/orders", "50 (fixed)", "no"],
                ["GET /api/parts", "25 (fixed)", "no"],
                ["GET /api/audit-log", "100 (fixed)", "no"],
                ["GET /api/vendors", "no limit — returns all", "no"],
                ["GET /api/org/workshops", "no limit — returns all", "no"],
                ["GET /api/rfqs/:id/quotes", "no limit — grows with items × vendors", "no"],
                ["GET /api/notifications", "100", "limit (1–100, default 30)"],
                ["GET /api/workflow/run-log", "1000", "limit (1–1000, default 200)"],
              ].map(([a, b, c]) => (
                <tr key={a} className="trow">
                  <td className="td font-mono text-[12px]">{a}</td>
                  <td className="td">{b}</td>
                  <td className="td text-muted">{c}</td>
                </tr>
              ))}
            </Table>
          </Section>

          {/* ── CORE RESOURCES ────────────────────────────────────────────────────────────── */}
          <Section
            id="resources"
            title="Core resources"
            icon={Boxes}
            lede="159 routes are registered. These are the ones that make sense as an integration surface; the rest drive the product's own screens and are not documented as a contract.">
            <P>
              "Platform staff" below means a Qparts employee account. A workspace role — however
              senior, including <C>company_admin</C> — can never satisfy it, so these are endpoints
              your integration will not be able to call unless it runs as our staff.
            </P>

            <H3>Identity</H3>
            <Table head={["Endpoint", "What it is for", "X-Tenant", "Who"]}>
              <tr className="trow">
                <td className="td font-mono text-[12px]">GET /api/me</td>
                <td className="td">Who you are, which workspace and environment the server resolved.</td>
                <td className="td text-muted">optional</td>
                <td className="td text-muted">any user</td>
              </tr>
              <tr className="trow">
                <td className="td font-mono text-[12px]">GET /api/workspaces</td>
                <td className="td">Every workspace this account can address, with the slug for <C>X-Tenant</C>.</td>
                <td className="td text-muted">no</td>
                <td className="td text-muted">any user</td>
              </tr>
              <tr className="trow">
                <td className="td font-mono text-[12px]">GET /api/workspaces/branches</td>
                <td className="td">Workshop branches you may raise a request for. Source of <C>workshopBranchId</C>.</td>
                <td className="td text-muted">required</td>
                <td className="td text-muted">any user</td>
              </tr>
            </Table>
            <Code
              label="List your workspaces"
              code={`curl ${base}/api/workspaces -H "Authorization: Bearer $QVM_TOKEN"

# {"count":2,"workspaces":[
#   {"id":"315860d1-…","slug":"jeddah","name":"Qparts Jeddah","via":"platform","role":"super_admin"},
#   {"id":"9ee1d8c6-…","slug":"${tenant}","name":"Qparts Riyadh","via":"platform","role":"super_admin"}]}`}
            />

            <H3>Requests for quote</H3>
            <P>
              An RFQ is the head of the order chain: a workshop branch asks for parts, vendors quote,
              a winning quote is chosen, and confirming it creates the order.
            </P>
            <Table head={["Endpoint", "What it is for", "Who"]}>
              {[
                ["POST /api/rfqs", "Raise a request. Needs a branch and at least one item.", "company_admin, branch_manager, service_advisor"],
                ["GET /api/rfqs", "The 50 most recent requests in this workspace.", "any user"],
                ["GET /api/rfqs/:id", "One request with its items and the vendors it went to.", "any user"],
                ["POST /api/rfqs/:id/send", "Invite vendors to quote. Mints one signed link per vendor.", "platform staff"],
                ["GET /api/rfqs/:id/quotes", "Quote comparison — every vendor's price per line.", "platform staff"],
                ["POST /api/rfqs/:id/items/:itemId/winning-quote", "Pick the winning quote for a line.", "platform staff"],
                ["POST /api/rfqs/:id/confirm", "Turn the request into an order.", "company_admin, branch_manager, service_advisor"],
              ].map(([a, b, c]) => (
                <tr key={a} className="trow">
                  <td className="td font-mono text-[12px]">{a}</td>
                  <td className="td">{b}</td>
                  <td className="td text-muted">{c}</td>
                </tr>
              ))}
            </Table>
            <Code
              label="Create a request"
              code={`curl -X POST ${base}/api/rfqs \\
  -H "Authorization: Bearer $QVM_TOKEN" \\
  -H 'X-Tenant: ${tenant}' \\
  -H 'X-Environment: sandbox' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "workshopBranchId": "5ac9a960-df94-4233-8839-a0f6cb38e4a2",
    "plateNumber": "DOC-1234",
    "items": [
      { "partNumber": "04465-42160", "partDescription": "Front brake pads", "quantity": 2 }
    ]
  }'

# 201 {"id":"522abc10-9eb7-4ffd-9052-18949511b8c6","orderNumber":"CEN-SBX-1","itemCount":1}`}
            />
            <P>
              Only <C>workshopBranchId</C> and a non-empty <C>items</C> array are required. Optional on
              the request: <C>plateNumber</C>, <C>vin</C>, <C>carBrandId</C>, <C>model</C>,{" "}
              <C>orderType</C> (<C>regular</C> | <C>bulk</C>), <C>deliveryType</C> (<C>delivery</C> |{" "}
              <C>pickup</C>). Optional on each item: <C>partNumber</C>, <C>partDescription</C>,{" "}
              <C>quantity</C> (default 1), <C>brandClassId</C>, <C>partCategoryId</C>.
            </P>

            <H3>Orders, directory and master data</H3>
            <Table head={["Endpoint", "What it is for", "X-Tenant", "Who"]}>
              {[
                ["GET /api/orders", "Confirmed orders, 50 most recent.", "required", "any user"],
                ["GET /api/vendors", "Supplier directory.", "optional", "any user"],
                ["GET /api/vendors/:id", "One supplier, with branches, accounts and recent quotations.", "optional", "any user"],
                ["POST /api/vendors", "Create a supplier. A company needs taxNumber; an individual needs primaryPhone.", "target", "platform staff"],
                ["GET /api/org/workshops", "Customer (workshop) directory.", "optional", "any user"],
                ["POST /api/org/workshops", "Create a workshop. Field is name, not legalName.", "target", "platform staff"],
                ["GET /api/parts?q=", "Search the parts master. 25 results, matches English, Arabic and synonyms.", "required", "any user"],
                ["GET /api/notifications", "The signed-in user's in-app inbox.", "required", "any user"],
                ["GET /api/workflow/run-log", "What moved and what the workflow engine did about it.", "required", "company_admin"],
                ["GET /api/audit-log", "Append-only trail of entity mutations (metadata only).", "required", "platform staff"],
              ].map(([a, b, c, d]) => (
                <tr key={a} className="trow">
                  <td className="td font-mono text-[12px]">{a}</td>
                  <td className="td">{b}</td>
                  <td className="td text-muted">{c}</td>
                  <td className="td text-muted">{d}</td>
                </tr>
              ))}
            </Table>
            <Code
              label="Search parts"
              code={`curl "${base}/api/parts?q=filter" \\
  -H "Authorization: Bearer $QVM_TOKEN" -H 'X-Tenant: ${tenant}'

# {"count":1,"parts":[{"id":"01b84407-…","name_en":"Oil Filter","name_ar":"فلتر زيت","category":"Engine"}]}`}
            />
            <Note>
              <C>GET /api/vendors</C> and <C>GET /api/org/workshops</C> return a different set of
              columns depending on whether a workspace is in scope. With <C>X-Tenant</C>, <C>status</C>{" "}
              is the link status within that workspace; without it (platform staff only), <C>status</C>{" "}
              is the global active flag and an extra <C>workspaces</C> count appears. Send the header
              consistently so the shape does not change under you.
            </Note>
          </Section>

          {/* ── WEBHOOKS ──────────────────────────────────────────────────────────────────── */}
          <Section
            id="webhooks"
            title="Webhooks"
            icon={Webhook}
            lede="Outbound only: QVM calls your server when a record crosses a step in a workflow. There is no inbound webhook endpoint — nothing here receives a signed call from you.">
            <H3>You do not configure this — they do</H3>
            <P>
              A webhook is an <b className="font-medium text-ink">action attached to a transition</b> in
              a workflow: an arrow between two steps, not a subscription to a topic. It is set up
              inside the workspace's own builder, which you have no access to. There is no
              subscription API, so there is nothing for you to call to register a URL — the workspace
              adds it for you, and which arrows carry the action is how they choose which events you
              receive. There is no filter expression either.
            </P>
            <Note>
              <b className="font-medium text-ink">What to send the workspace administrator.</b> Ask
              them to add the <C>Call another system</C> action to each transition you need, pointing
              at your endpoint, and to send you the signing secret for the environment you are
              integrating with. Your URL must be <C>https</C> and resolve to a publicly routable
              address — a private or loopback address is refused when they save it, so a tunnel to
              your laptop will not be accepted. The exact rules are in{" "}
              <b className="font-medium text-ink">Security</b> below, and it is worth quoting them the
              relevant line if their save is rejected.
            </Note>

            <H3>The guarantee</H3>
            <P>
              The delivery row is written inside the same database transaction as the status move. If
              the move is refused or rolled back, no delivery exists. You will therefore never be told
              about something that did not really happen — and, because sending happens afterwards from
              a background pass, a delivery you receive is always about a change that has already
              committed.
            </P>

            <H3>The payload</H3>
            <P>
              One event type exists today: <C>workflow.transition</C>. The body is frozen when it is
              queued, so every retry sends byte-for-byte the same bytes.
            </P>
            <Code
              label="POST body"
              code={`{
  "delivery": "3f2b6c1e-8d4a-4a71-9c2e-11ab77f0c9d5",
  "event": "workflow.transition",
  "workspace": "${tenant}",
  "environment": "${env}",
  "occurredAt": "2026-07-29T05:12:44.117Z",
  "transition": { "key": "priced>confirmed", "from": "priced", "to": "confirmed" },
  "automatic": false,
  "record": {
    "type": "order",
    "id": "1c145d43-06f9-469b-b380-5e0fa219fd38",
    "reference": "RYD-1",
    "part": null
  }
}`}
            />
            <P>
              <C>record.type</C> is one of <C>rfq</C>, <C>rfq_item</C>, <C>order</C>,{" "}
              <C>order_item</C>. <C>automatic</C> is <C>true</C> when the engine advanced the record
              itself rather than a person clicking. <C>part</C> is <C>null</C> for whole-record types.
              The payload cannot be widened from a flow definition — these fields are the contract.
            </P>

            <H3>Headers</H3>
            <Table head={["Header", "Value"]}>
              <tr className="trow">
                <td className="td font-mono text-[12px]">x-qvm-delivery</td>
                <td className="td">Delivery id. Identical on every retry — de-duplicate on it.</td>
              </tr>
              <tr className="trow">
                <td className="td font-mono text-[12px]">x-qvm-timestamp</td>
                <td className="td">Unix seconds, when this attempt was signed.</td>
              </tr>
              <tr className="trow">
                <td className="td font-mono text-[12px]">x-qvm-signature</td>
                <td className="td font-mono text-[12px]">v1=&lt;hex hmac&gt;</td>
              </tr>
            </Table>
            <P>
              Also sent: <C>content-type: application/json</C>, <C>user-agent: QVM-Workflow/1</C>,{" "}
              <C>cache-control: no-store</C>.
            </P>

            <H3>Verifying the signature</H3>
            <Code label="The scheme" code={`signature = hex( HMAC_SHA256( secret, timestamp + "." + rawBody ) )`} />
            <P>
              Two properties are doing the work here, and missing either one leaves you unprotected.{" "}
              <b className="font-medium text-ink">The timestamp is inside the signed message</b>, not
              merely sent beside it — so a captured request cannot be replayed with a fresh timestamp,
              because changing it breaks the signature. And{" "}
              <b className="font-medium text-ink">you must verify against the raw bytes you read</b>,
              before any JSON parsing: a re-serialised object is free to change key order, spacing and
              unicode escaping, and will not match.
            </P>

            <H3>Get your signing secret</H3>
            <P>
              One secret per workspace <i>per environment</i> — live and sandbox differ, so fetch it
              twice. It is minted on first read. Callable by a Qparts super admin only; there is no
              rotation endpoint.
            </P>
            <Code
              label="Fetch the secret"
              code={`curl ${base}/api/admin/workflows/webhook-secret \\
  -H "Authorization: Bearer $QVM_TOKEN" \\
  -H 'X-Tenant: ${tenant}' \\
  -H 'X-Environment: ${env}'

# {"environment":"${env}",
#  "secret":"0591dad02f684d478e98ab9a34265bcc92804b5d60f145eeb8c76a625a3182fd",
#  "scheme":{"algorithm":"HMAC-SHA256",
#            "signedMessage":"<x-qvm-timestamp> + '.' + <raw request body>",
#            "headers":{"x-qvm-delivery":"…","x-qvm-timestamp":"…","x-qvm-signature":"v1=<hex hmac>"}}}`}
            />

            <Code
              label="Receiver — Node (express)"
              code={`import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.QVM_WEBHOOK_SECRET;
const app = express();

// The raw bytes matter: a re-serialised object will not match the signature.
app.post("/qvm-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const timestamp = req.get("x-qvm-timestamp");
  const presented = req.get("x-qvm-signature");
  if (!timestamp || !presented) return res.status(400).send("unsigned");

  // Reject a stale capture: without this, one captured request replays forever.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > 300) return res.status(400).send("stale");

  const expected = Buffer.from(
    "v1=" + createHmac("sha256", SECRET).update(timestamp + "." + req.body).digest("hex"),
  );
  const given = Buffer.from(presented);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return res.status(400).send("bad signature");

  const event = JSON.parse(req.body.toString("utf8"));
  // At-least-once: the same delivery id can arrive more than once. Answer 2xx and do nothing.
  if (alreadyHandled(event.delivery)) return res.sendStatus(200);
  handle(event);
  res.sendStatus(200);
});`}
            />

            <Code
              label="Receiver — Python (flask)"
              code={`import hmac, hashlib, json, time, os
from flask import Flask, request

SECRET = os.environ["QVM_WEBHOOK_SECRET"].encode()
app = Flask(__name__)

@app.post("/qvm-webhook")
def qvm_webhook():
    raw = request.get_data()  # RAW bytes — not request.json, which re-serialises
    timestamp = request.headers.get("X-QVM-Timestamp", "")
    presented = request.headers.get("X-QVM-Signature", "")
    if not timestamp or not presented:
        return "unsigned", 400

    # Reject a stale capture: without this, one captured request replays forever.
    if abs(time.time() - int(timestamp)) > 300:
        return "stale", 400

    expected = "v1=" + hmac.new(
        SECRET, timestamp.encode() + b"." + raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, presented):
        return "bad signature", 400

    event = json.loads(raw)
    # At-least-once: the same delivery id can arrive more than once. Answer 2xx and do nothing.
    if already_handled(event["delivery"]):
        return "", 200
    handle(event)
    return "", 200`}
            />
            <Note>
              Compare in constant time — <C>timingSafeEqual</C> in Node,{" "}
              <C>hmac.compare_digest</C> in Python. A short-circuiting <C>==</C> leaks how much of a
              guess was correct, one byte at a time, which is enough to forge a signature without ever
              learning the secret. Five minutes is a reasonable freshness window; we use it in our own
              reference verifier.
            </Note>

            <H3>Delivery, retries, and giving up</H3>
            <P>
              A background pass runs every 30 seconds and takes up to 25 due deliveries per workspace
              and environment. Any <C>2xx</C> is success. Anything else is retried on a fixed schedule:
            </P>
            <Table head={["Attempt", "Waits before it"]}>
              {[["1", "immediate"], ["2", "1 minute"], ["3", "5 minutes"], ["4", "15 minutes"], ["5", "1 hour"], ["6", "3 hours"], ["—", "final wait 6 hours"]].map(([a, b]) => (
                <tr key={a + b} className="trow">
                  <td className="td tnum">{a}</td>
                  <td className="td text-muted">{b}</td>
                </tr>
              ))}
            </Table>
            <P>
              Six attempts, spanning a little over eleven hours — chosen to be longer than a night, so
              a receiver that broke at 9pm and was fixed at 8am still gets its deliveries. After the
              sixth the delivery is marked dead and{" "}
              <b className="font-medium text-ink">nobody will ever try again</b>. A failed row appears
              in <b className="font-medium text-ink">Status Logs</b>, which is the only place that
              tells you; there is no separate webhook alert.
            </P>
            <Note tone="warn" title="At-least-once, never exactly-once.">
              A receiver that processes a request and then fails to answer is indistinguishable, from
              our side, from one that never received it — so we retry. De-duplicate on{" "}
              <C>delivery</C>, which is stable across every attempt and is present{" "}
              <i>inside the signed body</i> as well as in the header. Only the body is covered by the
              HMAC, so the body's copy is the authenticated one. A delivery you have already handled
              must still be answered <C>2xx</C>.
            </Note>

            <H3>Where we will and will not call</H3>
            <P>
              The destination is chosen by whoever authors the workflow, so it is validated hard. If
              your URL is rejected, it is one of these:
            </P>
            <Table head={["Rule", "Why"]}>
              {[
                ["https only", "http would put the payload and its signature on the wire in clear."],
                ["No username or password in the URL", "It would be stored in the database and echoed into error messages."],
                ["No #fragment", "It is never transmitted, so it can only mislead."],
                ["At most 2048 characters", "Matches the database constraint on the stored destination."],
                ["Public IP addresses only", "Loopback, RFC 1918 private, link-local, carrier-NAT, multicast, documentation and reserved ranges are refused on IPv4 and IPv6 — as is the cloud metadata address 169.254.169.254, by name."],
                ["Names meaning this machine are refused", "localhost, and anything ending .local, .internal, .localhost or .localdomain."],
                ["Redirects are not followed", "A 3xx is recorded as a failure. Publish the final https URL — a guard on the first hop is worthless if hop two can be anywhere."],
              ].map(([a, b]) => (
                <tr key={a} className="trow">
                  <td className="td w-64 align-top font-medium">{a}</td>
                  <td className="td">{b}</td>
                </tr>
              ))}
            </Table>
            <P>
              The address is resolved and judged at the moment of sending, and the connection is opened
              to the address that was judged — so a hostname that answers with a public address when
              the flow is saved and a private one later is still refused. Every address a name resolves
              to must pass, not just the first.
            </P>

            <H3>Timeouts and volume</H3>
            <P>
              Answer within <b className="font-medium text-ink">5 seconds</b> of idle and{" "}
              <b className="font-medium text-ink">10 seconds</b> overall, or the attempt is abandoned
              and retried. Acknowledge first and do the work afterwards. We read at most 8 KB of your
              response body, only ever to quote it back in an error message. A workspace may queue
              10,000 webhook actions per environment per day, counted from midnight in the workspace's
              business calendar timezone; retries do not count against it. Past the cap the record
              still moves and the run log records the action as <C>Daily limit</C>.
            </P>
          </Section>

          {/* ── VENDOR QUOTE LINKS ────────────────────────────────────────────────────────── */}
          <Section
            id="quote-links"
            title="Vendor quote links"
            icon={Link2}
            lede="A supplier can price a request without ever having an account, through a single-purpose signed link. This is the one write path in the product that takes no token at all.">
            <P>
              When an RFQ is sent to a vendor, a random token is minted for that vendor and that RFQ.
              The link is the credential: whoever holds it may submit a quote, and nothing else. The
              token is stored only as a SHA-256 hash, so it cannot be recovered from our database — and
              it carries its own workspace and environment, so a sandbox link can only ever write
              sandbox rows regardless of what headers are sent with it.
            </P>
            <Table head={["", ""]}>
              <tr className="trow">
                <td className="td w-52 align-top font-medium">Token</td>
                <td className="td">24 random bytes, base64url — a 32-character string.</td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Lifetime</td>
                <td className="td">7 days from when the RFQ was sent.</td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Reusable</td>
                <td className="td">
                  Yes. A vendor may revise its quote until the RFQ is confirmed; a second submission
                  updates the lines rather than being rejected.
                </td>
              </tr>
              <tr className="trow">
                <td className="td align-top font-medium">Headers</td>
                <td className="td">None. No <C>Authorization</C>, no <C>X-Tenant</C>, no <C>X-Environment</C>.</td>
              </tr>
            </Table>

            <Code
              label="Submit a quote — no authentication"
              code={`curl -X POST ${base}/api/quote-access/fi-NKqyGECgaLAHzT7d8F-tVLOVJfmxp/quote \\
  -H 'Content-Type: application/json' \\
  -d '{
    "items": [
      { "rfqItemId": "e865104f-1490-41b0-aa50-7473408ad73a",
        "offeredCost": 275.5,
        "slaHours": 48,
        "availableQty": 2,
        "notes": "in stock" }
    ]
  }'

# 201 {"quoted":1,"status":"priced"}`}
            />
            <P>
              Required per line: <C>rfqItemId</C> and <C>offeredCost</C>. Optional: <C>slaHours</C>,{" "}
              <C>availableQty</C>, <C>alternativePartNumber</C> (≤64 chars), <C>notes</C> (≤256 chars).
            </P>
            <Note tone="warn" title="Check the returned count.">
              Lines whose <C>rfqItemId</C> does not belong to this RFQ are{" "}
              <b className="font-medium text-ink">silently dropped</b>, not rejected. <C>quoted</C> can
              legitimately be smaller than the number of items you sent, and that is the only signal
              you get. Compare it against what you submitted.
            </Note>
            <Table head={["Failure", "Response"]}>
              {[
                ["Unknown token", "404 invalid quote link"],
                ["Token older than 7 days", "400 quote link expired"],
                ["The RFQ has already been confirmed into an order", "400 this RFQ is already confirmed"],
                ["No submitted line belongs to this RFQ", "400 no valid items for this RFQ"],
              ].map(([a, b]) => (
                <tr key={a} className="trow">
                  <td className="td">{a}</td>
                  <td className="td font-mono text-[12px]">{b}</td>
                </tr>
              ))}
            </Table>
            <Note>
              The raw token is handed to the notification layer and never persisted, so in production
              it exists only in the message sent to the vendor. Outside production,{" "}
              <C>POST /api/rfqs/:id/send</C> returns it in the response so you can test the flow:{" "}
              <C>{`{"rfqId":"…","sent":1,"isSandbox":true,"results":[{"vendorId":"…","notify":"suppressed","token":"fi-NKqyGECg…"}]}`}</C>
              . Since no environment actually delivers email today, that is currently the only way to
              obtain one.
            </Note>
          </Section>

          {/* ── MCP ──────────────────────────────────────────────────────────────────────────
              Documented ahead of the implementation, at the product owner's request, and carrying
              the one word that keeps that honest: PREVIEW, in the heading and in the first line.
              Every other section on this page answers today. This one is a specification of what
              will answer, and a reader who tries the endpoint now gets a connection refused — so
              the page has to say so before they spend an afternoon on it. Everything else here is
              real: the tools map one-to-one onto endpoints documented above, the header trio is
              the same trio, and the client configuration snippets are the actual formats those
              clients take, so none of it has to be rewritten when the server lands.
              ──────────────────────────────────────────────────────────────────────────────── */}
          <Section
            id="mcp"
            title="MCP server"
            icon={Plug}
            badge="Preview"
            lede={
              <>
                Point an AI agent at a workspace instead of writing a client. Same credentials, same
                permissions, and the same audit trail as the REST API above.{" "}
                <b className="font-medium text-ink">Not open for connections yet.</b> Nothing is
                listening for MCP at that URL today: a client pointed at it gets this website's HTML
                back with a <C>200</C>, so it will fail inside your client on a parse error rather
                than on a refused connection. This section is here so you can design against it —
                ask your Qparts contact to be told when it opens.
              </>
            }>
            <H3>What it is</H3>
            <P>
              The Model Context Protocol is an open standard for handing an AI agent a set of tools
              it can discover and call. An MCP client — Claude Desktop, Claude Code, Cursor, or an
              agent you built yourself — connects to a server, reads the tools it offers, and calls
              them on the model's behalf.
            </P>
            <P>
              This server puts one workspace behind that protocol. An agent can raise a request,
              read what the vendors quoted, pick a winner, book a delivery and move an order along,
              without you writing an HTTP client for any of it.
            </P>
            <P>
              Every tool below is one of the endpoints documented above, described to the agent.{" "}
              <b className="font-medium text-ink">
                Nothing is reachable through MCP that is not reachable over HTTP
              </b>{" "}
              — the protocol changes who is driving, not what they are allowed to do.
            </P>

            <H3>The endpoint</H3>
            <Table head={["", ""]}>
              {[
                ["URL", `${base}/mcp`],
                ["Transport", "Streamable HTTP. No stdio server to install and nothing to run on your side."],
                ["Authentication", "The same bearer token as the REST API. Obtained the same way, expires the same way."],
                ["Workspace", "X-Tenant, sent as a connection header rather than per call."],
                ["Environment", "X-Environment, likewise. Pinned for the whole session — see below."],
              ].map(([a, b]) => (
                <tr key={a} className="trow">
                  <td className="td w-44 align-top font-medium">{a}</td>
                  <td className="td font-mono text-[12px]">{b}</td>
                </tr>
              ))}
            </Table>

            <H3>Connecting</H3>
            <P>
              Get a token exactly as in <a className="link" href="#authentication">Authentication</a>,
              then register the server with your client. Both placeholders below are yours to
              replace — <C>{"<your-workspace>"}</C> and the environment.
            </P>
            <Code
              label="Claude Code"
              code={`claude mcp add --transport http qparts ${base}/mcp \\
  --header "Authorization: Bearer $QPARTS_TOKEN" \\
  --header "X-Tenant: ${tenant}" \\
  --header "X-Environment: sandbox"`}
            />
            <Code
              label="Claude Desktop — claude_desktop_config.json"
              code={`{
  "mcpServers": {
    "qparts": {
      "type": "http",
      "url": "${base}/mcp",
      "headers": {
        "Authorization": "Bearer <token>",
        "X-Tenant": "${tenant}",
        "X-Environment": "sandbox"
      }
    }
  }
}`}
            />
            <P>
              Cursor, Windsurf and most other clients take the same <C>mcpServers</C> object; only
              the file it lives in differs. An agent you wrote yourself connects to the same URL with
              the same three headers.
            </P>

            <H3>The tools</H3>
            <P>
              Names and shapes are stable. A tool marked <b className="font-medium text-ink">writes</b>{" "}
              changes data in the workspace.
            </P>
            <Table head={["Tool", "What it does", ""]}>
              {[
                ["list_rfqs", "Requests in the workspace, newest first, under the same cap as the REST list.", ""],
                ["get_rfq", "One request: its lines, the vendors it went to, and every quote received.", ""],
                ["create_rfq", "Raises a request for a workshop branch, with its part lines.", "writes"],
                ["send_rfq_to_vendors", "Invites vendors to quote and issues each one a quote link.", "writes"],
                ["get_quotes", "Every vendor's price against a line, with the winner marked if one is chosen.", ""],
                ["select_winning_quote", "Picks the vendor for one line and moves that line's status.", "writes"],
                ["confirm_rfq", "Turns a priced request into an order.", "writes"],
                ["list_orders", "Orders in the workspace, filterable by status.", ""],
                ["get_order", "One order with its lines, deliveries and invoice.", ""],
                ["record_delivery", "Books a full or partial delivery against order lines.", "writes"],
                ["issue_invoice", "Invoices a delivered order.", "writes"],
                ["list_vendors", "Vendors this workspace can send to, with their activation state.", ""],
                ["get_record_workflow", "Which flow a record is in, the step it sits on, and the moves available from here.", ""],
                ["move_status", "Moves a record along its workflow. Refused when the flow has no arrow for it.", "writes"],
              ].map(([a, b, c]) => (
                <tr key={a} className="trow">
                  <td className="td whitespace-nowrap align-top font-mono text-[12px]">{a}</td>
                  <td className="td">{b}</td>
                  <td className="td w-20 align-top">
                    {c && (
                      <span className="rounded-full bg-[var(--chip-red-bg)] px-2 py-0.5 text-[11px] font-medium text-accent">
                        {c}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>

            <H3>Permissions are the token's permissions</H3>
            <P>
              The agent is the user whose token you connected with. It gains nothing by arriving over
              MCP: a role that cannot confirm an order over HTTP cannot confirm one here either, and
              the tool is not offered to that session at all rather than offered and then refused.
            </P>
            <P>
              Every write is attributed to that user in the workspace's status log, marked as having
              arrived through MCP. Give the integration its own account with the smallest role that
              does the job — the same advice as for the REST API, and for the same reason.
            </P>

            <H3>Environment is fixed when you connect</H3>
            <P>
              <C>X-Environment</C> is a connection header, not a per-call argument, so an agent
              cannot decide mid-conversation to write to <C>live</C>. A session pointed at{" "}
              <C>sandbox</C> stays in sandbox until you reconfigure the client yourself. Build
              against sandbox; move the header when you are finished.
            </P>
            <Note tone="warn" title="A write tool is a real write">
              An agent calling <C>create_rfq</C> creates a request that vendors can see, and{" "}
              <C>confirm_rfq</C> creates an order somebody will be invoiced for. Nothing is staged
              and nothing waits for a human unless the workspace's own workflow puts an approval in
              the way. Turn on your client's confirmation prompt for write tools before you point one
              at <C>live</C>.
            </Note>
          </Section>

          {/* ── ERRORS ────────────────────────────────────────────────────────────────────── */}
          <Section
            id="errors"
            title="Errors"
            icon={TriangleAlert}
            lede="Failures come back in more than one shape. Handle both, because the same status code can arrive in either.">
            <H3>The two bodies</H3>
            <P>
              Most failures use the framework's shape, with <C>message</C> as a{" "}
              <b className="font-medium text-ink">string</b>:
            </P>
            <Code code={`{"message":"no workspace resolved (subdomain / X-Tenant)","error":"Bad Request","statusCode":400}`} />
            <P>
              Input validation uses a different shape, with <C>message</C> as an{" "}
              <b className="font-medium text-ink">array</b> of <C>field: problem</C> strings — and the
              keys are in the opposite order:
            </P>
            <Code code={`{"statusCode":400,"error":"Bad Request","message":["workshopBranchId: Required","items: an RFQ needs at least one item"]}`} />
            <Note tone="warn" title="A 400 can be either of these.">
              A business rule returns a string; a schema violation returns an array. A client that
              assumes one will crash on the other. Test with{" "}
              <C>typeof body.message === "string"</C> before you display it.
            </Note>
            <P>
              Two further exceptions: an unhandled server error returns{" "}
              <C>{`{"statusCode":500,"message":"Internal server error"}`}</C> with{" "}
              <b className="font-medium text-ink">no</b> <C>error</C> key, and an oversized body
              returns <C>{`{"statusCode":413,"message":"request entity too large"}`}</C>, also without
              one.
            </P>

            <H3>What you will actually see</H3>
            <P>
              Guards run before validation, so an authentication or permission failure always beats a
              malformed body — you will not learn your payload was wrong until the credentials are
              right.
            </P>
            <Table head={["Status", "message", "Meaning"]}>
              {[
                ["401", "missing bearer token", "No Authorization header, or it does not begin with 'Bearer '."],
                ["401", "invalid token", "Expired, tampered, or signed with another key. Indistinguishable — log in again."],
                ["401", "user is deactivated", "The account was switched off. The token dies immediately, not at expiry."],
                ["401", "invalid credentials", "Login failed. Identical for unknown email, wrong password and inactive user."],
                ["400", "no workspace resolved (subdomain / X-Tenant)", "This route needs a workspace and none was given."],
                ["403", "unknown or inactive workspace", "The slug does not resolve to an active workspace."],
                ["403", "no access to this workspace", "Real workspace, but this user is not a member of it."],
                ["403", "this action is restricted to platform staff", "A Qparts-staff-only endpoint. No workspace role satisfies it."],
                ["403", "insufficient role for this action", "Authenticated, in the workspace, wrong role."],
                ["404", "<thing> not found in this workspace", "Missing, in another workspace, or in the other environment — deliberately indistinguishable."],
                ["404", "Cannot GET /api/…", "No such route."],
                ["409", "email already registered", "Signup collision. Also used for duplicate counterparty identifiers."],
                ["413", "request entity too large", "Body over 100 KB."],
              ].map(([a, b, c]) => (
                <tr key={a + b} className="trow">
                  <td className="td tnum align-top">{a}</td>
                  <td className="td whitespace-nowrap align-top font-mono text-[12px]">{b}</td>
                  <td className="td">{c}</td>
                </tr>
              ))}
            </Table>
          </Section>

          {/* ── LIMITS ────────────────────────────────────────────────────────────────────── */}
          <Section id="limits" title="Limits" icon={ListTree} lede="The numbers, in one place.">
            <Table head={["", ""]}>
              {[
                ["Rate limiting", "None. There is no throttle on any endpoint, authenticated or not. Please be considerate — every authenticated request opens a database transaction and runs two to five queries before your handler is reached."],
                ["Request body", "100 KB."],
                ["List results", "Capped per endpoint; see Making requests. No pagination exists to reach past a cap."],
                ["Token lifetime", "1 day by default. No refresh."],
                ["Quote link lifetime", "7 days."],
                ["Webhook attempts", "6, over roughly 11 hours, then abandoned."],
                ["Webhook batch", "25 deliveries per workspace, per environment, per 30-second pass."],
                ["Webhook response read", "8 KB. Your reply body is only ever used to quote in an error."],
                ["Webhook timeouts", "5 s idle, 10 s total."],
                ["Webhook daily cap", "10,000 per workspace per environment, from midnight in the workspace's business calendar timezone."],
                ["Destination URL", "2048 characters."],
              ].map(([a, b]) => (
                <tr key={a} className="trow">
                  <td className="td w-56 align-top font-medium">{a}</td>
                  <td className="td">{b}</td>
                </tr>
              ))}
            </Table>
          </Section>

          {/* ── GAPS ──────────────────────────────────────────────────────────────────────── */}
          <Section
            id="gaps"
            title="What is not available yet"
            icon={ShieldAlert}
            lede="Listed so you can plan around them rather than discover them. Nothing here is hidden behind a flag or an enterprise tier — it does not exist.">
            <Table head={["Missing", "What to do instead"]}>
              {[
                [
                  "API keys, service accounts, OAuth",
                  "Authenticate as a real user. Your system will hold that user's password. Give the integration its own account with the least role that works, so you can deactivate it without touching a person's login.",
                ],
                [
                  "Token refresh",
                  "There is no refresh endpoint and no way to extend a token. Keep the credentials and log in again when a 401 arrives.",
                ],
                [
                  "Pagination",
                  "No offset, cursor, page or after parameter exists anywhere. Rows past a list's cap cannot be reached through the API. Sync the head of the list, or ask us for an export.",
                ],
                [
                  "Webhook secret rotation",
                  "There is no rotation endpoint. A compromised secret needs us to intervene directly.",
                ],
                [
                  "Inbound webhooks",
                  "Nothing here accepts a signed call from your system. The raw request body is not captured, so we could not verify one today even if a route existed. Use the REST endpoints.",
                ],
                [
                  "Events other than workflow.transition",
                  "One event type exists. Anything you want to react to must be modelled as a step a record moves into.",
                ],
                [
                  "Email and WhatsApp delivery",
                  "Recorded, never sent — in every environment, including production. Do not build a flow that assumes a vendor or workshop received a message from us. In-app notifications are real.",
                ],
                [
                  "Webhook suppression in sandbox",
                  "Sandbox flows make real outbound calls. Configure sandbox flows with a test destination.",
                ],
                [
                  "Idempotency keys",
                  "Writes are not idempotent and there is no Idempotency-Key header. A retried POST creates a second record.",
                ],
                [
                  "API versioning",
                  "No version segment, no version header, no deprecation channel. Breaking changes are not currently signalled — pin nothing and re-check this page.",
                ],
                [
                  "An OpenAPI / Swagger document",
                  "This page is the specification.",
                ],
              ].map(([a, b]) => (
                <tr key={a} className="trow">
                  <td className="td w-64 align-top font-medium">{a}</td>
                  <td className="td">{b}</td>
                </tr>
              ))}
            </Table>
            <Note>
              If something above is blocking an integration, tell your Qparts contact which one. The
              order these get built in is decided by which of them is actually stopping somebody.
            </Note>
          </Section>
        </div>
      </div>
      </div>
    </div>
  );
}
