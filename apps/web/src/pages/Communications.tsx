import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight, Bell, Check, CheckCheck, Inbox, Mail, MessageCircle, MessagesSquare, Plug, Send,
  ShieldCheck, Users,
} from "lucide-react";
import { api } from "../lib/api";
import { refreshUnread } from "../lib/unread";

/**
 * COMMUNICATIONS PORTAL.
 *
 * The place a workspace connects its OWN WhatsApp Business number and its OWN Gmail, and then talks
 * to workshops and vendors from inside QVM instead of from a phone and a separate inbox.
 *
 * TWO KINDS OF THING LIVE HERE, AND THE PAGE MUST NOT BLUR THEM:
 *
 *   IN-APP NOTIFICATIONS (top)  — real. They are rows this application writes and reads, so there is
 *                                 no provider to be missing and nothing being claimed on credit. The
 *                                 sidebar badge counts exactly what this list shows.
 *
 *   WHATSAPP AND GMAIL (below)  — still not connected. The providers are not wired, so no message can
 *                                 leave QVM through this portal. Those cards describe what each
 *                                 channel WILL do and what it still needs, and they say so in the
 *                                 present tense. A screen that pretends to be live is worse than one
 *                                 that says "not yet", because the first thing anyone does with a
 *                                 messaging feature is trust it with a message.
 */

/** One row of the in-app inbox, exactly as GET /notifications returns it. */
interface Note {
  id: string;
  title: string;
  body: string | null;
  /** An in-app router path; the API refuses anything else at write time. */
  link: string | null;
  kind: string;
  read_at: string | null;
  created_at: string;
}

function ago(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const KIND_LABEL: Record<string, string> = {
  approval: "Approval",
  workflow: "Workflow",
  digest: "Digest",
  system: "System",
};

/**
 * THE IN-APP INBOX — the only part of this page that is connected to anything.
 *
 * Marking read tells the badge immediately via refreshUnread(). Waiting for the badge's own poll
 * would leave the sidebar contradicting the list the reader is looking at, and a count that
 * disagrees with the screen beside it is how an unread number stops being believed.
 */
function InAppInbox() {
  const [rows, setRows] = useState<Note[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ rows: Note[] }>("/notifications?limit=30");
      setRows(r.rows ?? []);
      setErr(null);
    } catch (e) {
      // Say the read failed. An error rendered as an empty inbox tells the reader they have nothing
      // waiting, which is a stronger claim than "I could not find out".
      setErr(e instanceof Error ? e.message : "could not load notifications");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markOne(id: string) {
    setBusy(true);
    try {
      await api.post(`/notifications/${id}/read`);
      await load();
      refreshUnread();
    } finally {
      setBusy(false);
    }
  }

  async function markAll() {
    setBusy(true);
    try {
      await api.post("/notifications/read-all");
      await load();
      refreshUnread();
    } finally {
      setBusy(false);
    }
  }

  const unread = (rows ?? []).filter((n) => !n.read_at).length;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent text-white">
          <Bell className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-ink">
            Notifications
            {unread > 0 && (
              <span className="ml-2 rounded-full bg-navy px-1.5 py-0.5 text-[10.5px] font-bold leading-none text-white">
                {unread}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Raised inside QVM and delivered inside QVM — this list needs no provider, which is why it
            works while the channels below do not.
          </p>
        </div>
        {unread > 0 && (
          <button disabled={busy} onClick={markAll} className="btn btn-sm shrink-0">
            <CheckCheck className="h-3.5 w-3.5" /> Mark all read
          </button>
        )}
      </div>

      {err && (
        <p className="border-b border-line px-4 py-2.5 text-[12.5px] text-accent">{err}</p>
      )}

      {rows === null ? (
        <p className="px-4 py-6 text-center text-[12.5px] text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <Inbox className="mx-auto h-5 w-5 text-faint" />
          <p className="mt-2 text-[13px] font-medium text-ink">Nothing waiting on you</p>
          <p className="mx-auto mt-0.5 max-w-md text-[12px] leading-relaxed text-muted">
            Notifications land here when the system needs a person — an approval sitting on your
            decision, for instance. Empty means empty, not unwired.
          </p>
        </div>
      ) : (
        <ul>
          {rows.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 border-b border-line px-4 py-3 last:border-0 ${
                n.read_at ? "" : "bg-accent-50/30"
              }`}
            >
              {/* The unread marker is a dot, not a colour alone — colour alone is invisible to a
                  reader who cannot distinguish it. */}
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-accent"}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{n.title}</p>
                {n.body && <p className="mt-0.5 text-[12.5px] leading-relaxed text-sub">{n.body}</p>}
                <p className="mt-0.5 text-[11px] text-faint">
                  {KIND_LABEL[n.kind] ?? n.kind} · {ago(n.created_at)}
                  {n.read_at && " · read"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {n.link && (
                  <Link
                    to={n.link}
                    onClick={() => {
                      // Opening it IS reading it. Leaving it unread after the reader has gone to the
                      // screen it points at would make the badge outlive the thing it is about.
                      if (!n.read_at) void markOne(n.id);
                    }}
                    className="btn btn-sm"
                  >
                    Open <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                )}
                {!n.read_at && (
                  <button
                    disabled={busy}
                    onClick={() => markOne(n.id)}
                    className="btn btn-sm"
                    title="Mark read"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ChannelKey = "whatsapp" | "gmail";

interface ChannelDef {
  key: ChannelKey;
  name: string;
  tagline: string;
  /** Brand colour, used only for the icon tile so the two are instantly distinguishable. */
  tint: string;
  icon: typeof MessageCircle;
  /** What connecting it actually unlocks — concrete, not marketing. */
  unlocks: string[];
  /** What the workspace has to bring. Being specific here is what makes the ask actionable. */
  requires: string[];
}

const CHANNELS: ChannelDef[] = [
  {
    key: "whatsapp",
    name: "WhatsApp Business",
    tagline: "Talk to workshops and vendors on the number they already message you on.",
    tint: "#25D366",
    icon: MessageCircle,
    unlocks: [
      "Send a quote request to a vendor as a WhatsApp message, not just an email link",
      "Replies land against the order they belong to, instead of in someone's phone",
      "Delivery and pickup updates go out automatically as the order moves",
    ],
    requires: [
      "A WhatsApp Business account with a verified number",
      "A Meta Business app with the WhatsApp product enabled",
      "Message templates approved by Meta (required for anything you send first)",
    ],
  },
  {
    key: "gmail",
    name: "Gmail",
    tagline: "Send and receive from your own workspace address, threaded to the record.",
    tint: "#EA4335",
    icon: Mail,
    unlocks: [
      "RFQ invitations sent from your own domain rather than a no-reply address",
      "Vendor replies attached to the RFQ automatically, so nothing sits unread in one inbox",
      "A full history on every order of who was told what, and when",
    ],
    requires: [
      "A Google Workspace account for the address you want to send from",
      "OAuth consent for QVM to send and read on that mailbox",
    ],
  },
];

function ChannelCard({ c }: { c: ChannelDef }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card overflow-hidden">
      <div className="flex items-start gap-3.5 p-4">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white"
          style={{ background: c.tint }}
        >
          <c.icon className="h-[22px] w-[22px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-ink">{c.name}</h3>
            <span className="rounded-md bg-[var(--chip-gray-bg)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--chip-gray-fg)]">
              Not connected
            </span>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{c.tagline}</p>
        </div>
      </div>

      <div className="border-t border-line px-4 py-3.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-wide text-faint">What it unlocks</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {c.unlocks.map((u) => (
            <li key={u} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-sub">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--chip-green-fg)]" />
              {u}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-line px-4 py-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[12px] font-medium text-navy hover:underline"
        >
          {open ? "Hide what you need" : `What you need to connect it (${c.requires.length})`}
        </button>
        {open && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {c.requires.map((r) => (
              <li key={r} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" />
                {r}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line bg-surface px-4 py-3">
        <button className="btn btn-sm w-full justify-center" disabled title="The provider is not wired up yet">
          <Plug className="h-4 w-4" /> Connect {c.name}
        </button>
      </div>
    </div>
  );
}

export default function Communications() {
  return (
    <div className="flex flex-col gap-5">
      {/* header */}
      <div className="flex items-start gap-3.5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-white">
          <MessagesSquare className="h-[22px] w-[22px]" />
        </span>
        <div>
          <h1 className="text-[20px] font-semibold text-ink">Communications</h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Everything the system has to tell a person, in one place — and, once the channels below
            are connected, everything this workspace says to workshops and vendors too.
          </p>
        </div>
      </div>

      {/* REAL. Kept above the "not connected" notice so the notice cannot be read as covering it. */}
      <InAppInbox />

      {/* the honest status line — this is still the most important sentence on the page */}
      <div className="rounded-lg border border-[var(--chip-amber-bg)] bg-[var(--chip-amber-bg)]/30 px-4 py-3">
        <p className="text-[13px] font-medium text-ink">
          WhatsApp and email are not connected
        </p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-sub">
          Their providers are not wired up, so no message can leave QVM through this portal today.
          The notifications above are a different thing: they are delivered inside the product, to the
          person they are addressed to. Everything below describes what each outbound channel will do
          once it is connected — it is a plan, not a live integration.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {CHANNELS.map((c) => <ChannelCard key={c.key} c={c} />)}
      </div>

      {/* why it is one portal rather than a setting on each screen */}
      <div className="card p-4">
        <h2 className="text-[14px] font-semibold text-ink">Why these live together</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          A workshop chases an order on WhatsApp, a vendor replies by email, and the person handling
          it has to hold both threads in their head. Putting the channels in one portal means the
          conversation belongs to the <em>order</em>, not to whoever happened to receive it — so the
          next person to pick it up can see everything that was said.
        </p>
        <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
          {[
            { icon: Send, title: "One outbox", body: "Messages go out from the order, whichever channel they use." },
            { icon: Users, title: "No private threads", body: "A reply reaches the team, not one person's phone." },
            { icon: ShieldCheck, title: "Kept with the record", body: "Every message stays attached to the order it is about." },
          ].map((f) => (
            <div key={f.title} className="rounded-lg border border-line bg-surface p-3">
              <f.icon className="h-4 w-4 text-navy" />
              <p className="mt-1.5 text-[12.5px] font-semibold text-ink">{f.title}</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-[12px] text-faint">
        Want a channel that is not here? <ArrowRight className="h-3.5 w-3.5" /> tell us which one and
        what you would send through it.
      </p>
    </div>
  );
}
