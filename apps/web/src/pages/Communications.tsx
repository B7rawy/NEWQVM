import { useState } from "react";
import {
  ArrowRight, Check, Mail, MessageCircle, MessagesSquare, Plug, Send, ShieldCheck, Users,
} from "lucide-react";

/**
 * COMMUNICATIONS PORTAL.
 *
 * The place a workspace connects its OWN WhatsApp Business number and its OWN Gmail, and then talks
 * to workshops and vendors from inside QVM instead of from a phone and a separate inbox.
 *
 * Nothing is connected yet — the providers are not wired. This page is deliberately honest about
 * that rather than showing a fake inbox: every channel says exactly what it will do and what it
 * still needs. A screen that pretends to be live is worse than one that says "not yet", because the
 * first thing anyone does with a messaging feature is trust it with a message.
 */

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
            Connect your own WhatsApp number and Gmail, and talk to workshops and vendors from inside
            QVM — with every message kept against the order it belongs to.
          </p>
        </div>
      </div>

      {/* the honest status line — this is the most important sentence on the page */}
      <div className="rounded-lg border border-[var(--chip-amber-bg)] bg-[var(--chip-amber-bg)]/30 px-4 py-3">
        <p className="text-[13px] font-medium text-ink">Nothing is connected yet</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-sub">
          The providers are not wired up, so no message can leave QVM through this portal today.
          Everything below describes what each channel will do once it is connected — it is a plan,
          not a live integration.
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
