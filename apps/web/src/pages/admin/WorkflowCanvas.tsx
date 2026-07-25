import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Ban, Copy, Frame, Lock, Play, Plus, Redo2, Save, Send, Settings2,
  Sparkles, Trash2, Undo2, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { api } from "../../lib/api";
import { useTargetWorkspace } from "../../lib/target-workspace";

/**
 * Full-screen workflow builder. Deliberately OUTSIDE AppShell: a canvas wants the whole viewport.
 *
 * Hand-built on SVG rather than a graph library — CONVENTIONS forbids heavy bundles. The two things
 * that make a canvas feel right are done properly here rather than approximated:
 *   • VIEW TRANSFORM — one {x, y, k} applied to the world, so pan and zoom are continuous. (Scaling
 *     a scroll container instead, as the first cut did, makes zoom jump and pan feel like scrolling.)
 *   • HISTORY — the graph is ONE state object, so every edit is a snapshot and undo is exact.
 *
 * The graph is one document keyed by status CODE (never uuid) — the same shape the API accepts and
 * the assistant returns, so hand-drawing, generating, and mixing the two are one code path.
 */

/** What the inspector is pointed at: a step by status code, or an edge by "from>to". */
type Sel = { kind: "step" | "edge"; key: string };

const NODE_W = 190;
const NODE_H = 68;
const GRID = 20;
const MIN_K = 0.25;
const MAX_K = 2.5;

type FlowStatus = "draft" | "active" | "retired";
interface CatalogStatus { code: string; label_en: string; label_ar: string }
interface Step { status: string; label: string; isEntry: boolean; isTerminal: boolean; slaHours?: number | null; x: number; y: number; pages: string[]; ownerRoles: string[] }
interface RoutablePage { key: string; path: string; labelEn: string; entities: string[]; personas: string[]; wired: boolean }
type Handoff = "pool" | "keep" | "actor";
interface Edge { from: string; to: string; label?: string | null; requiresApproval: boolean; allowedRoles: string[]; priority: number; handoff: Handoff }
interface Graph { steps: Step[]; edges: Edge[] }
interface FlowDoc {
  id: string; flow_key: string; version: number; name_en: string; name_ar: string;
  status: FlowStatus; is_default: boolean; status_domain: "item" | "vendor";
  steps: Array<Record<string, unknown>>; transitions: Array<Record<string, unknown>>;
}

const CHIP: Record<FlowStatus, string> = {
  draft: "bg-[var(--chip-amber-bg)] text-[var(--chip-amber-fg)]",
  active: "bg-[var(--chip-green-bg)] text-[var(--chip-green-fg)]",
  retired: "bg-[var(--chip-gray-bg)] text-[var(--chip-gray-fg)]",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Toggleable chips. Shows the whole vocabulary AND the current answer in the same space. */
function Chips({ options, value, onChange, disabled, empty }: {
  options: Array<{ key: string; label: string; hint?: string; warn?: boolean }>;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  empty: string;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const on = value.includes(o.key);
          return (
            <button key={o.key} type="button" disabled={disabled} title={o.hint}
              onClick={() => onChange(on ? value.filter((v) => v !== o.key) : [...value, o.key])}
              className={`rounded-md border px-1.5 py-1 text-[11px] leading-none transition disabled:opacity-50 ${
                on ? "border-navy bg-navy text-white" : "border-line bg-surface text-sub hover:border-line-2"
              }`}>
              {o.label}{o.warn && on ? " ⚠" : ""}
            </button>
          );
        })}
      </div>
      {value.length === 0 && <p className="mt-1 text-[11px] text-faint">{empty}</p>}
    </>
  );
}

export default function WorkflowCanvas() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { target } = useTargetWorkspace();

  const [flow, setFlow] = useState<FlowDoc | null>(null);
  const [graph, setGraph] = useState<Graph>({ steps: [], edges: [] });
  const [catalog, setCatalog] = useState<CatalogStatus[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [pages, setPages] = useState<RoutablePage[]>([]);
  /** How many people actually hold each role here — restricting a step to a role nobody holds
   *  is the fastest way to wedge a workspace, so it is shown while the choice is being made. */
  const [holders, setHolders] = useState<Record<string, number>>({});
  const [sel, setSel] = useState<Sel | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rail, setRail] = useState<"inspector" | "assistant">("inspector");
  const [adding, setAdding] = useState(false);
  const [panning, setPanning] = useState(false);

  /** The view transform: world → screen is `p * k + {x,y}`. */
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [histSize, setHistSize] = useState({ past: 0, future: 0 });
  /** Bumped to request a fit AFTER React has committed the new graph — a setTimeout guess
   *  ran while graphRef still held the old graph and framed the wrong bounds. */
  const [fitReq, setFitReq] = useState(0);

  const wrap = useRef<HTMLDivElement>(null);
  const hist = useRef<{ past: Graph[]; future: Graph[]; lastKey: string | null }>({ past: [], future: [], lastKey: null });
  const drag = useRef<{ code: string; dx: number; dy: number; moved: boolean } | null>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const frozen = flow?.status !== "draft";
  const { steps, edges } = graph;

  // ── history ───────────────────────────────────────────────────────────────
  /**
   * Push an edit onto the history stack.
   *
   * `coalesceKey` identifies a continuously-edited field (e.g. one transition's label). Consecutive
   * commits carrying the SAME key reuse the existing history entry instead of adding one per
   * keystroke — which used to blow the 100-entry cap and evict real structural edits from the bottom.
   */
  const commit = useCallback((next: Graph, coalesceKey?: string | false) => {
    const h = hist.current;
    if (!coalesceKey || h.lastKey !== coalesceKey) {
      h.past.push(graphRef.current);
      if (h.past.length > 100) h.past.shift();
    }
    h.lastKey = coalesceKey || null;
    h.future = [];
    setHistSize({ past: h.past.length, future: 0 });
    setGraph(next);
    setDirty(true);
  }, []);

  const undo = useCallback(() => {
    const h = hist.current;
    if (!h.past.length) return;
    h.future.unshift(graphRef.current);
    h.lastKey = null;
    setGraph(h.past.pop()!);
    setHistSize({ past: h.past.length, future: h.future.length });
    setDirty(true);
    setSel(null);
    setLinkFrom(null); // the arrow being drawn may have started at a step this undo just removed
  }, []);

  const redo = useCallback(() => {
    const h = hist.current;
    if (!h.future.length) return;
    h.past.push(graphRef.current);
    h.lastKey = null;
    setGraph(h.future.shift()!);
    setHistSize({ past: h.past.length, future: h.future.length });
    setDirty(true);
    setSel(null);
    setLinkFrom(null);
  }, []);

  // ── load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const [f, c] = await Promise.all([
      api.get<FlowDoc>(`/admin/workflows/${id}`, { tenant: target }),
      api.get<{
        itemStatuses: CatalogStatus[]; vendorStatuses: CatalogStatus[]; roles: string[];
        pages: RoutablePage[]; holders: Record<string, number>;
      }>("/admin/workflows/catalog", { tenant: target }),
    ]);
    setFlow(f);
    setCatalog(f.status_domain === "vendor" ? c.vendorStatuses : c.itemStatuses);
    setRoles(c.roles);
    setPages(c.pages ?? []);
    setHolders(c.holders ?? {});
    setGraph({
      steps: f.steps.map((s) => ({
        status: s.status as string,
        label: (s.label_en as string) || (s.status as string),
        isEntry: !!s.is_entry,
        isTerminal: !!s.is_terminal,
        slaHours: (s.sla_hours as number) ?? null,
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        pages: (s.pages as string[]) ?? [],
        ownerRoles: (s.owner_roles as string[]) ?? [],
      })),
      edges: f.transitions.map((t) => ({
        from: t.from as string,
        to: t.to as string,
        label: (t.label_en as string) ?? null,
        requiresApproval: !!t.requires_approval,
        allowedRoles: (t.allowed_roles as string[]) ?? [],
        priority: (t.priority as number) ?? 0,
        handoff: ((t.handoff as Handoff) ?? "pool"),
      })),
    });
    hist.current = { past: [], future: [], lastKey: null };
    setHistSize({ past: 0, future: 0 });
    setDirty(false);
  }, [id, target]);

  useEffect(() => {
    load().catch((e) => setMsg({ kind: "err", text: (e as Error).message }));
  }, [load]);

  // ── pan / zoom ────────────────────────────────────────────────────────────
  const toWorld = useCallback(
    (cx: number, cy: number) => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    },
    [view],
  );

  /** Zoom about a screen point so the world under the cursor stays put — the thing that makes
   *  wheel-zoom feel anchored rather than lurching toward a corner. */
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    const r0 = wrap.current?.getBoundingClientRect();
    if (!r0) return;
    setView((v) => {
      const r = r0;
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const sx = cx - r.left;
      const sy = cy - r.top;
      return { k, x: sx - (sx - v.x) * (k / v.k), y: sy - (sy - v.y) * (k / v.k) };
    });
  }, []);

  const zoomCenter = useCallback(
    (factor: number) => {
      const r = wrap.current?.getBoundingClientRect();
      if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    },
    [zoomAt],
  );

  /** Frame every node with a little padding. */
  const fit = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    const ss = graphRef.current.steps;
    if (!r || ss.length === 0) return setView({ x: 40, y: 40, k: 1 });
    // A hidden or not-yet-laid-out canvas measures 0×0, and fitting to that yields a negative scale
    // that clamps to the minimum and parks the graph off-screen. Leave the view alone instead.
    if (r.width < 50 || r.height < 50) return;
    const minX = Math.min(...ss.map((s) => s.x));
    const minY = Math.min(...ss.map((s) => s.y));
    const maxX = Math.max(...ss.map((s) => s.x + NODE_W));
    const maxY = Math.max(...ss.map((s) => s.y + NODE_H));
    const pad = 80;
    const k = clamp(Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY), 1.2), MIN_K, MAX_K);
    setView({ k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - (maxY - minY) * k) / 2 - minY * k });
  }, []);

  // Fit ONLY when something explicitly asks for it (the Fit button, ⌘0, or a fresh AI proposal).
  // `graph` must stay OUT of these deps: dragging a node calls setGraph on every pointermove, so a
  // `graph` dep re-framed the view on every frame and the canvas appeared to zoom itself out the
  // moment you touched a node. Reading the graph through graphRef inside fit() is safe because that
  // ref is assigned during render — it already holds the committed graph by the time this effect
  // runs, which is the guarantee the `graph` dep was mistakenly added to provide.
  useEffect(() => {
    if (fitReq > 0) fit();
  }, [fitReq, fit]);

  // wheel: zoom at the pointer; shift+wheel nudges sideways (trackpad pinch arrives as ctrl+wheel)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      // deltaMode 1 = lines, 2 = pages. Chrome reports pixels, Firefox reports lines — without this
      // normalisation a Firefox notch moved the view ~1/16th as far as the same notch in Chrome.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Chromium and WebKit swap the axis for shift+wheel and deliver it on deltaX; Firefox leaves
        // it on deltaY. Reading only deltaY made this gesture a no-op in every browser but Firefox.
        const dx = (e.deltaX || e.deltaY) * unit;
        setView((v) => ({ ...v, x: v.x - dx }));
        return;
      }
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.0015));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // `flow` is in the deps on purpose: on first mount this component renders the loading branch,
    // so wrap.current is null and the listener silently never attaches. Re-running once the canvas
    // exists is what makes wheel-zoom work at all.
  }, [zoomAt, flow]);

  // node dragging and canvas panning share the pointer stream
  useEffect(() => {
    function move(e: PointerEvent) {
      if (pan.current) {
        // capture BEFORE setView: React may run the updater after pointerup has nulled pan.current,
        // and dereferencing it in there crashes the canvas on a quick release.
        const { vx, vy, sx, sy } = pan.current;
        const nx = vx + (e.clientX - sx);
        const ny = vy + (e.clientY - sy);
        setView((v) => ({ ...v, x: nx, y: ny }));
        return;
      }
      const d = drag.current;
      if (!d) return;
      const w = toWorld(e.clientX, e.clientY);
      const x = Math.round((w.x - d.dx) / GRID) * GRID;
      const y = Math.round((w.y - d.dy) / GRID) * GRID;
      // `moved` must mean the node ACTUALLY changed cells, not merely that a pointermove fired. A
      // mouse emits a move for 1-2px of hand tremor, and since positions snap to GRID that produced
      // an identical graph — yet it kept the pre-recorded undo entry, wiped the redo stack and
      // marked the flow unsaved, so a plain select-click looked like an edit.
      const cur = graphRef.current.steps.find((s) => s.status === d.code);
      if (cur && cur.x === x && cur.y === y) return;
      d.moved = true;
      setGraph((g) => ({ ...g, steps: g.steps.map((s) => (s.status === d.code ? { ...s, x, y } : s)) }));
    }
    // `cancel` covers the paths that never deliver a pointerup: a right-click opening the native
    // context menu, a touch cancelled by the OS, or the window losing focus mid-gesture. Without it
    // the pre-recorded history entry leaked and drag.current stayed armed after the button was up.
    function finish(applied: boolean) {
      // a drag is ONE history entry, not one per animation frame
      if (drag.current) {
        hist.current.lastKey = null;
        const before = hist.current.past[hist.current.past.length - 1];
        if (applied && drag.current.moved) {
          hist.current.future = [];
          setDirty(true);
        } else {
          // a click that never moved should not be undoable; and an ABANDONED drag must put the node
          // back where it was rather than leave the move applied with its undo entry popped
          hist.current.past.pop();
          if (drag.current.moved && before) setGraph(before);
        }
        setHistSize({ past: hist.current.past.length, future: hist.current.future.length });
      }
      drag.current = null;
      pan.current = null;
      setPanning(false);
    }
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [toWorld]);

  // ── graph edits ───────────────────────────────────────────────────────────
  const byCode = useMemo(() => new Map(steps.map((s) => [s.status, s])), [steps]);
  const unused = catalog.filter((c) => !byCode.has(c.code));

  /**
   * Delete `target`, defaulting to the current selection.
   *
   * The explicit argument is not a convenience. A node's own X button suppresses the node's
   * pointerdown (so clicking X does not also drag the node), which means `sel` is still whatever was
   * selected BEFORE the click. Calling a no-argument remove from there deleted the previously
   * selected element — a different node, or an edge, or nothing at all. Passing the target the user
   * actually clicked removes the ambiguity entirely.
   */
  const removeSelection = useCallback(
    (target?: Sel) => {
      const t = target ?? sel;
      if (frozen || !t) return;
      const g = graphRef.current;
      if (t.kind === "step") {
        commit({
          steps: g.steps.filter((s) => s.status !== t.key),
          edges: g.edges.filter((e) => e.from !== t.key && e.to !== t.key),
        });
      } else {
        const [from, to] = t.key.split(">");
        commit({ ...g, edges: g.edges.filter((e) => !(e.from === from && e.to === to)) });
      }
      setSel(null);
      setLinkFrom(null); // a half-drawn arrow must not survive the disappearance of its source
    },
    [frozen, sel, commit],
  );

  // keyboard: the shortcuts people reach for without being told
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (sel) e.preventDefault();
        removeSelection();
      } else if (e.key === "Escape") {
        setLinkFrom(null);
        setSel(null);
        setAdding(false);
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomCenter(1.2);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomCenter(1 / 1.2);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        fit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, removeSelection, sel, zoomCenter, fit]);

  function addStep(code: string) {
    const c = catalog.find((x) => x.code === code);
    const r = wrap.current?.getBoundingClientRect();
    // drop it in the middle of what the user is currently looking at
    const w = r
      ? { x: (r.width / 2 - view.x) / view.k - NODE_W / 2, y: (r.height / 2 - view.y) / view.k - NODE_H / 2 }
      : { x: 80, y: 80 };
    // Negative world coordinates are legal (the API takes any finite number), so do NOT clamp to 0 —
    // that used to fling the node to world origin exactly when the user had panned away from it.
    let x = Math.round(w.x / GRID) * GRID;
    let y = Math.round(w.y / GRID) * GRID;
    // and step it off anything already sitting there, so a second add is never hidden under the first
    while (steps.some((st) => st.x === x && st.y === y)) { x += GRID * 2; y += GRID * 2; }
    commit({
      ...graph,
      steps: [...steps, {
        status: code,
        label: c?.label_en || code,
        isEntry: steps.length === 0,
        isTerminal: false,
        pages: [], ownerRoles: [],
        x, y,
      }],
    });
    setAdding(false);
  }

  function link(to: string) {
    if (!linkFrom || linkFrom === to) return setLinkFrom(null);
    // The source can vanish between arming the link and clicking the target (delete, undo, or an AI
    // proposal replacing the graph). Such an edge draws as nothing but still serialises into save().
    if (!byCode.has(linkFrom) || !byCode.has(to)) return setLinkFrom(null);
    if (!edges.some((e) => e.from === linkFrom && e.to === to)) {
      commit({ ...graph, edges: [...edges, { from: linkFrom, to, requiresApproval: false, allowedRoles: [], priority: 0, handoff: "pool" }] });
    }
    setLinkFrom(null);
  }

  // Free-text and numeric fields coalesce: consecutive edits to the SAME field collapse into one
  // undo entry, so ⌘Z steps back over a whole typed label rather than one character at a time.
  const patchStep = (code: string, p: Partial<Step>, coalesce?: string) =>
    commit({ ...graph, steps: steps.map((s) => (s.status === code ? { ...s, ...p } : s)) }, coalesce && `${code}:${coalesce}`);
  const patchEdge = (key: string, p: Partial<Edge>, coalesce?: string) =>
    commit({ ...graph, edges: edges.map((e) => (`${e.from}>${e.to}` === key ? { ...e, ...p } : e)) }, coalesce && `${key}:${coalesce}`);

  async function save() {
    setBusy(true); setMsg(null);
    const sent = graphRef.current; // what this request actually carries
    try {
      await api.put(`/admin/workflows/${id}/graph`, {
        steps: steps.map((s) => ({
          status: s.status, isEntry: s.isEntry, isTerminal: s.isTerminal,
          slaHours: s.slaHours ?? null, x: Math.round(s.x), y: Math.round(s.y),
          pages: s.pages, ownerRoles: s.ownerRoles,
        })),
        transitions: edges.map((e) => ({
          from: e.from, to: e.to, labelEn: e.label ?? null,
          requiresApproval: e.requiresApproval, allowedRoles: e.allowedRoles, priority: e.priority,
          handoff: e.handoff,
        })),
      }, { tenant: target });
      // Only declare the document clean if nothing changed while the request was in flight;
      // otherwise the edit made during the save would look saved when the server never saw it.
      if (graphRef.current === sent) setDirty(false);
      setMsg({ kind: "ok", text: graphRef.current === sent ? "Saved" : "Saved — you have newer edits" });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally { setBusy(false); }
  }

  async function act(path: string, okText: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ id: string }>(`/admin/workflows/${id}/${path}`, {}, { tenant: target });
      if (path === "new-version") return nav(`/admin/workflows/${r.id}`);
      await load();
      setMsg({ kind: "ok", text: okText });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally { setBusy(false); }
  }

  if (!flow) {
    return (
      <div className="grid h-screen place-items-center bg-appbg text-[13px] text-muted">
        {msg ? <span className="text-accent">{msg.text}</span> : "Loading…"}
      </div>
    );
  }

  const selStep = sel?.kind === "step" ? byCode.get(sel.key) : undefined;
  const selEdge = sel?.kind === "edge" ? edges.find((e) => `${e.from}>${e.to}` === sel.key) : undefined;

  return (
    <div className="flex h-screen flex-col bg-appbg" dir="ltr">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <button onClick={() => nav("/admin/workflows")} title="Back to workflows"
          className="grid h-8 w-8 place-items-center rounded-md border border-line text-muted transition hover:bg-surface hover:text-ink">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[14.5px] font-semibold text-ink">{flow.name_en}</h1>
            <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase ${CHIP[flow.status]}`}>{flow.status}</span>
          </div>
          <p className="text-[11.5px] text-faint">
            {flow.flow_key} · v{flow.version} · {steps.length} steps · {edges.length} transitions
            {dirty && <span className="text-[var(--chip-amber-fg)]"> · unsaved</span>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {msg && <span className={`text-[12px] ${msg.kind === "err" ? "text-accent" : "text-muted"}`}>{msg.text}</span>}
          {!frozen && (
            <>
              <button className="btn btn-sm" onClick={save} disabled={busy || !dirty}>
                <Save className="h-4 w-4" /> Save
              </button>
              <button className="btn-primary rounded-md px-3 py-1.5 text-[13px]" onClick={() => act("activate", "Activated")}
                disabled={busy || dirty} title={dirty ? "Save your changes first" : "Make this the live workflow"}>
                <Play className="h-4 w-4" /> Activate
              </button>
            </>
          )}
          {flow.status === "active" && (
            <>
              <button className="btn btn-sm" onClick={() => act("new-version", "")} disabled={busy}>
                <Copy className="h-4 w-4" /> New version
              </button>
              <button className="btn btn-sm" onClick={() => act("retire", "Retired")} disabled={busy}>
                <Ban className="h-4 w-4" /> Retire
              </button>
            </>
          )}
        </div>
      </header>

      {frozen && (
        <div className="shrink-0 border-b border-line bg-surface px-4 py-2 text-[12.5px] text-sub">
          This workflow is <b>{flow.status}</b> — orders may be running on it, so its rules are frozen.
          Use <b>New version</b> to change it: the whole graph is copied into a fresh draft, and
          activating that retires this one while in-flight orders finish on the version they started.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {/* toolbar */}
          <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg border border-line bg-panel p-1 shadow-cardsm">
            {!frozen && (
              <>
                <div className="relative">
                  <button onClick={() => setAdding((v) => !v)}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-sub hover:bg-surface">
                    <Plus className="h-4 w-4" /> Add step
                  </button>
                  {adding && (
                    <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-60 overflow-auto rounded-lg border border-line bg-panel py-1 shadow-pop">
                      {unused.length === 0 && <p className="px-3 py-2 text-[12px] text-faint">Every status is already on the canvas.</p>}
                      {unused.map((c) => (
                        <button key={c.code} onClick={() => addStep(c.code)}
                          className="block w-full px-3 py-1.5 text-left text-[12.5px] text-sub hover:bg-surface">
                          {c.label_en}<span className="block text-[10.5px] text-faint">{c.code}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mx-0.5 h-5 w-px bg-line" />
                <button onClick={undo} disabled={!histSize.past} title="Undo (⌘Z)"
                  className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface disabled:opacity-30">
                  <Undo2 className="h-4 w-4" />
                </button>
                <button onClick={redo} disabled={!histSize.future} title="Redo (⇧⌘Z)"
                  className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface disabled:opacity-30">
                  <Redo2 className="h-4 w-4" />
                </button>
              </>
            )}
            <div className="mx-0.5 h-5 w-px bg-line" />
            <button onClick={() => zoomCenter(1 / 1.2)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface" title="Zoom out (⌘−)">
              <ZoomOut className="h-4 w-4" />
            </button>
            <button onClick={() => zoomCenter(1 / view.k)} className="w-11 rounded-md py-1 text-center text-[11.5px] tabular-nums text-faint hover:bg-surface" title="Reset to 100%">
              {Math.round(view.k * 100)}%
            </button>
            <button onClick={() => zoomCenter(1.2)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface" title="Zoom in (⌘+)">
              <ZoomIn className="h-4 w-4" />
            </button>
            <button onClick={fit} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface" title="Fit to view (⌘0)">
              <Frame className="h-4 w-4" />
            </button>
          </div>

          <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md bg-panel/80 px-2.5 py-1 text-[11px] text-faint backdrop-blur">
            drag to pan · scroll to zoom · ⌫ delete · ⌘Z undo
          </div>

          {linkFrom && (
            <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-pop">
              Click the step this arrow goes to · <button className="underline" onClick={() => setLinkFrom(null)}>cancel</button>
            </div>
          )}

          {/* viewport */}
          <div
            ref={wrap}
            className={`h-full overflow-hidden ${panning ? "cursor-grabbing" : "cursor-grab"}`}
            style={{
              backgroundColor: "var(--surface)",
              backgroundImage: "radial-gradient(circle, var(--line) 1px, transparent 1px)",
              backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
              backgroundPosition: `${view.x}px ${view.y}px`,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 && e.button !== 1) return;
              pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
              setPanning(true);
              setSel(null);
              setAdding(false);
            }}
          >
            <div style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0", width: 0, height: 0 }}>
              <svg className="pointer-events-none absolute overflow-visible" width={1} height={1}>
                <defs>
                  <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
                  </marker>
                  <marker id="ah-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--navy)" />
                  </marker>
                </defs>
                {edges.map((e) => {
                  const a = byCode.get(e.from);
                  const b = byCode.get(e.to);
                  if (!a || !b) return null;
                  const key = `${e.from}>${e.to}`;
                  const on = sel?.kind === "edge" && sel.key === key;
                  const fwd = b.x >= a.x;
                  const x1 = a.x + (fwd ? NODE_W : 0);
                  const y1 = a.y + NODE_H / 2;
                  const x2 = b.x + (fwd ? 0 : NODE_W);
                  const y2 = b.y + NODE_H / 2;
                  const dx = Math.max(60, Math.abs(x2 - x1) * 0.5);
                  const d = `M ${x1} ${y1} C ${x1 + (fwd ? dx : -dx)} ${y1}, ${x2 - (fwd ? dx : -dx)} ${y2}, ${x2} ${y2}`;
                  const mx = (x1 + x2) / 2;
                  const my = (y1 + y2) / 2;
                  const text = e.label ?? (e.requiresApproval ? "approval" : "");
                  const w = Math.max(34, text.length * 6.4 + (e.requiresApproval ? 30 : 16));
                  const tx = e.requiresApproval ? 7 : 0; // shift text to clear the lock glyph
                  return (
                    <g key={key} className="pointer-events-auto cursor-pointer"
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => setSel({ kind: "edge", key })}>
                      {/* invisible fat path so a thin curve is still easy to hit */}
                      <path d={d} fill="none" stroke="transparent" strokeWidth={18} />
                      <path d={d} fill="none" stroke={on ? "var(--navy)" : "var(--muted)"}
                        strokeWidth={on ? 2.25 : 1.5} markerEnd={on ? "url(#ah-on)" : "url(#ah)"} />
                      {(text || on) && (
                        <g transform={`translate(${mx} ${my})`}>
                          <rect x={-w / 2} y={-10} width={w} height={20} rx={10}
                            fill="var(--panel)" stroke={on ? "var(--navy)" : "var(--line)"} />
                          {/* a DRAWN lock, not an emoji: emoji fall back to a system font that
                              ignores the canvas scale, so at 50% zoom it stayed huge next to
                              everything else that had shrunk. */}
                          {e.requiresApproval && (
                            <g transform={`translate(${-w / 2 + 11} 0)`} stroke="var(--muted)" strokeWidth={1.2} fill="none">
                              <rect x={-3.5} y={-1} width={7} height={6} rx={1.2} fill="var(--muted)" stroke="none" />
                              <path d="M -2 -1 V -2.6 a 2 2 0 0 1 4 0 V -1" />
                            </g>
                          )}
                          <text textAnchor="middle" x={tx} y={4} fontSize={11} fill="var(--sub)">
                            {text}
                          </text>
                        </g>
                      )}
                      {/* unlink right on the arrow — no hunting through the inspector */}
                      {on && !frozen && (
                        <g transform={`translate(${mx + w / 2 + 12} ${my})`} className="cursor-pointer"
                          onClick={(ev) => { ev.stopPropagation(); removeSelection(); }}>
                          <circle r={9} fill="var(--panel)" stroke="var(--line)" />
                          <path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" stroke="var(--accent, #d33)" strokeWidth={1.6} strokeLinecap="round" />
                        </g>
                      )}
                    </g>
                  );
                })}
              </svg>

              {steps.map((s) => {
                const on = sel?.kind === "step" && sel.key === s.status;
                const linkable = linkFrom && linkFrom !== s.status;
                return (
                  <div key={s.status}
                    onPointerDown={(ev) => {
                      ev.stopPropagation(); // do not start a pan
                      setSel({ kind: "step", key: s.status });
                      // Right/middle button must not arm a drag: the native context menu swallows the
                      // pointerup, so the pre-recorded history entry leaked and drag.current stayed
                      // armed after the button was released.
                      if (ev.button !== 0) return;
                      // A frozen flow is read-only everywhere else (inspector disabled, no Save
                      // button); without this gate a node could still be dragged into an unsaved
                      // state the UI offers no way to save or undo.
                      if (frozen) return;
                      const w = toWorld(ev.clientX, ev.clientY);
                      // pre-record so a real move is undoable; a plain click pops it back off
                      hist.current.past.push(graphRef.current);
                      drag.current = { code: s.status, dx: w.x - s.x, dy: w.y - s.y, moved: false };
                    }}
                    onClick={() => linkFrom && link(s.status)}
                    className={`group absolute select-none overflow-hidden rounded-xl border bg-panel shadow-cardsm transition-[border-color,box-shadow] ${frozen ? "cursor-default" : "cursor-grab active:cursor-grabbing"} ${
                      on ? "border-navy ring-2 ring-navy/15" : "border-line hover:border-line-2 hover:shadow-pop"
                    } ${linkable ? "ring-2 ring-accent/40" : ""}`}
                    style={{ left: s.x, top: s.y, width: NODE_W, height: NODE_H }}>
                    <span className="absolute left-0 top-0 h-full w-1"
                      style={{ background: s.isEntry ? "var(--chip-green-fg)" : s.isTerminal ? "var(--chip-gray-fg)" : "var(--line-2)" }} />
                    <div className="flex h-full flex-col justify-center gap-1 pl-3.5 pr-3">
                      <div className="truncate text-[13px] font-semibold text-ink">{s.label}</div>
                      <div className="flex items-center gap-1.5 overflow-hidden">
                        {s.isEntry && <span className="shrink-0 rounded bg-[var(--chip-green-bg)] px-1.5 py-px text-[9.5px] font-bold uppercase text-[var(--chip-green-fg)]">start</span>}
                        {s.isTerminal && <span className="shrink-0 rounded bg-[var(--chip-gray-bg)] px-1.5 py-px text-[9.5px] font-bold uppercase text-[var(--chip-gray-fg)]">end</span>}
                        {s.slaHours ? <span className="shrink-0 text-[10px] text-faint">{s.slaHours}h</span> : null}
                        <span className="truncate text-[10px] text-faint">{s.status}</span>
                      </div>
                    </div>
                    {!frozen && (
                      <>
                        <button onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => { ev.stopPropagation(); setLinkFrom(s.status); }}
                          title="Draw a transition from here"
                          className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full border border-line bg-panel text-faint opacity-0 shadow-cardsm transition group-hover:opacity-100 hover:border-accent hover:text-accent">
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => { ev.stopPropagation(); removeSelection({ kind: "step", key: s.status }); }}
                          title="Remove step"
                          className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full text-faint opacity-0 transition group-hover:opacity-100 hover:text-accent">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {steps.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="text-center">
                  <p className="text-[13.5px] font-medium text-sub">This workflow is empty</p>
                  <p className="mt-1 text-[12.5px] text-faint">
                    Add a step from the toolbar — or describe the flow to the assistant and let it draw one.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex shrink-0 border-b border-line">
            {([["inspector", "Inspector", Settings2], ["assistant", "Assistant", Sparkles]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setRail(k)}
                className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12.5px] font-medium transition ${
                  rail === k ? "border-b-2 border-navy text-ink" : "text-muted hover:text-sub"}`}>
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {/* NOT a ternary: unmounting AssistantPanel would discard the conversation. */}
            <div className={rail === "assistant" ? "h-full" : "hidden"}>
              <AssistantPanel
                flowId={id}
                tenant={target}
                frozen={frozen}
                graph={graph}
                onProposal={(g) => {
                  // the model returns CODES; the friendly label lives in the catalog the canvas
                  // already holds, so resolve here rather than shipping labels through the model
                  const label = new Map(catalog.map((c) => [c.code, c.label_en]));
                  commit({ ...g, steps: g.steps.map((s) => ({ ...s, label: label.get(s.status) || s.status })) });
                  setSel(null);
                  setFitReq((n) => n + 1);
                }}
              />
            </div>
            <div className={rail === "inspector" ? "" : "hidden"}>
            {!sel ? (
              <div className="pt-8 text-center">
                <Settings2 className="mx-auto h-7 w-7 text-faint" />
                <p className="mt-2 text-[12.5px] text-muted">Select a step or a transition to configure it.</p>
              </div>
            ) : selStep ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-[14px] font-semibold text-ink">{selStep.label}</h3>
                  <p className="text-[11px] text-faint">{selStep.status}</p>
                </div>
                <label className="flex items-start gap-2.5 text-[12.5px] text-sub">
                  <input type="checkbox" className="mt-0.5" disabled={frozen} checked={selStep.isEntry}
                    onChange={(e) =>
                      // exactly one entry — the DB enforces it, so MOVE the flag rather than add one
                      commit({ ...graph, steps: steps.map((s) => ({ ...s, isEntry: s.status === selStep.status ? e.target.checked : false })) })
                    } />
                  <span><b className="text-ink">Start</b><span className="block text-[11.5px] text-faint">New orders enter the workflow here</span></span>
                </label>
                <label className="flex items-start gap-2.5 text-[12.5px] text-sub">
                  <input type="checkbox" className="mt-0.5" disabled={frozen} checked={selStep.isTerminal}
                    onChange={(e) => patchStep(selStep.status, { isTerminal: e.target.checked })} />
                  <span><b className="text-ink">End</b><span className="block text-[11.5px] text-faint">The order is finished at this step</span></span>
                </label>
                <div>
                  <label className="label">Target duration (hours)</label>
                  <input className="input" type="number" min={1} disabled={frozen} placeholder="no target"
                    value={selStep.slaHours ?? ""}
                    onChange={(e) => patchStep(selStep.status, { slaHours: e.target.value ? Number(e.target.value) : null }, "slaHours")} />
                  <p className="mt-1 text-[11px] text-faint">Used to flag late orders in reporting.</p>
                </div>

                <div className="border-t border-line pt-3.5">
                  <label className="label">Who handles it here</label>
                  <Chips
                    disabled={frozen}
                    value={selStep.ownerRoles}
                    onChange={(v) => patchStep(selStep.status, { ownerRoles: v })}
                    empty="Anyone who can already reach the order."
                    options={roles.map((r) => ({
                      key: r,
                      label: r.replace(/_/g, " "),
                      // an owner nobody holds freezes every order at this step, so say so up front
                      warn: !holders[r],
                      hint: holders[r] ? `${holders[r]} in this workspace` : "nobody in this workspace holds this role",
                    }))}
                  />
                  {selStep.ownerRoles.some((r) => !holders[r]) && (
                    <p className="mt-1.5 text-[11px] text-accent">
                      ⚠ Nobody here holds {selStep.ownerRoles.filter((r) => !holders[r]).map((r) => r.replace(/_/g, " ")).join(", ")} —
                      orders would stall at this step. Assign someone, or leave this empty.
                    </p>
                  )}
                </div>

                <div>
                  <label className="label">Shows on</label>
                  <Chips
                    disabled={frozen && false /* routing stays fixable on a live flow — see 0048 */}
                    value={selStep.pages}
                    onChange={(v) => patchStep(selStep.status, { pages: v })}
                    empty="Everywhere it appears today — routing is off for this step."
                    options={pages.map((p) => ({
                      key: p.key,
                      label: p.labelEn,
                      warn: !p.wired,
                      hint: p.wired ? p.path : `${p.path} — this screen is not built yet`,
                    }))}
                  />
                  {selStep.pages.some((k) => pages.find((p) => p.key === k && !p.wired)) && (
                    <p className="mt-1.5 text-[11px] text-accent">
                      ⚠ One of these screens is not built yet — orders routed there would not be visible.
                    </p>
                  )}
                </div>
                {!frozen && (
                  <button className="btn btn-sm justify-center text-accent" onClick={() => removeSelection()}>
                    <Trash2 className="h-4 w-4" /> Remove step
                  </button>
                )}
              </div>
            ) : selEdge ? (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-[13.5px] font-semibold text-ink">
                    {byCode.get(selEdge.from)?.label} → {byCode.get(selEdge.to)?.label}
                  </h3>
                  <p className="text-[11px] text-faint">transition</p>
                </div>
                <div>
                  <label className="label">Label</label>
                  <input className="input" disabled={frozen} placeholder="Quote, Confirm…"
                    value={selEdge.label ?? ""}
                    onChange={(e) => patchEdge(`${selEdge.from}>${selEdge.to}`, { label: e.target.value }, "label")} />
                </div>
                <label className="flex items-start gap-2.5 text-[12.5px] text-sub">
                  <input type="checkbox" className="mt-0.5" disabled={frozen} checked={selEdge.requiresApproval}
                    onChange={(e) => patchEdge(`${selEdge.from}>${selEdge.to}`, { requiresApproval: e.target.checked })} />
                  <span>
                    <b className="flex items-center gap-1 text-ink"><Lock className="h-3.5 w-3.5" /> Needs approval</b>
                    <span className="block text-[11.5px] text-faint">The order waits here until someone approves</span>
                  </span>
                </label>
                <div>
                  <label className="label">Who holds it afterwards</label>
                  <div className="flex flex-col gap-1">
                    {([
                      ["pool", "Hand to the next desk", "Released to whoever owns the destination step"],
                      ["keep", "Same person keeps it", "Responsibility does not change hands"],
                      ["actor", "Whoever makes this move", "Doing it means taking it on"],
                    ] as const).map(([k, label, hint]) => (
                      <label key={k} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-[12px] ${
                        selEdge.handoff === k ? "border-navy bg-surface" : "border-line"}`}>
                        <input type="radio" className="mt-0.5" disabled={frozen}
                          checked={selEdge.handoff === k}
                          onChange={() => patchEdge(`${selEdge.from}>${selEdge.to}`, { handoff: k })} />
                        <span>
                          <b className="text-ink">{label}</b>
                          <span className="block text-[11px] text-faint">{hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="label">Who may do this</label>
                  <select className="input" disabled={frozen} value={selEdge.allowedRoles[0] ?? ""}
                    onChange={(e) => patchEdge(`${selEdge.from}>${selEdge.to}`, { allowedRoles: e.target.value ? [e.target.value] : [] })}>
                    <option value="">Anyone already permitted</option>
                    {roles.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                  </select>
                </div>
                {!frozen && (
                  <button className="btn btn-sm justify-center text-accent" onClick={() => removeSelection()}>
                    <Trash2 className="h-4 w-4" /> Remove transition
                  </button>
                )}
              </div>
            ) : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * Assistant panel — a CONVERSATION, not a command box.
 *
 * The whole exchange is sent every turn, so the assistant can ask "who approves that?" and use the
 * answer. It replies with words only when the request is a greeting, a question, or too vague to
 * draw — saying "hello" must not produce a whole workflow.
 *
 * When it does draw, the graph has already been validated server-side against the real status
 * catalog, and it lands as ONE undoable edit, so ⌘Z discards it wholesale. Nothing is ever saved
 * without the human pressing Save.
 */
function AssistantPanel({
  flowId, tenant, frozen, graph, onProposal,
}: {
  flowId: string;
  tenant: string | null;
  frozen: boolean;
  graph: Graph;
  onProposal: (g: Graph) => void;
}) {
  const [msgs, setMsgs] = useState<Array<{ role: "user" | "assistant"; text: string; drew?: boolean }>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    const history = [...msgs.map(({ role, text }) => ({ role, text })), { role: "user" as const, text: t }];
    setText("");
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setBusy(true);
    try {
      const r = await api.post<{
        reply: string; drew: boolean;
        steps?: Step[]; transitions?: Array<Record<string, unknown>>;
      }>(
        `/admin/workflows/${flowId}/assist`,
        {
          messages: history,
          graph: {
            steps: graph.steps.map((s) => ({
              status: s.status, isEntry: s.isEntry, isTerminal: s.isTerminal,
              slaHours: s.slaHours ?? null, x: s.x, y: s.y,
            })),
            transitions: graph.edges.map((e) => ({
              from: e.from, to: e.to, labelEn: e.label ?? null,
              requiresApproval: e.requiresApproval, allowedRoles: e.allowedRoles, priority: e.priority,
              handoff: e.handoff,
            })),
          },
        },
        { tenant },
      );
      if (r.drew && r.steps?.length) {
        onProposal({
          steps: r.steps.map((s) => ({
            status: s.status, label: s.status, isEntry: !!s.isEntry, isTerminal: !!s.isTerminal,
            slaHours: s.slaHours ?? null, x: Number(s.x) || 0, y: Number(s.y) || 0,
            pages: s.pages ?? [], ownerRoles: s.ownerRoles ?? [],
          })),
          edges: (r.transitions ?? []).map((t2) => ({
            from: t2.from as string, to: t2.to as string, label: (t2.labelEn as string) ?? null,
            requiresApproval: !!t2.requiresApproval, allowedRoles: (t2.allowedRoles as string[]) ?? [],
            priority: (t2.priority as number) ?? 0, handoff: ((t2.handoff as Handoff) ?? "pool"),
          })),
        });
      }
      setMsgs((m) => [...m, { role: "assistant", text: r.reply, drew: r.drew }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", text: (e as Error).message }]);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-auto">
        {msgs.length === 0 && (
          <div className="rounded-lg border border-line bg-surface p-3">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
              <Sparkles className="h-4 w-4 text-navy" /> Let’s work out the flow
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              Talk to it in Arabic or English. It will ask about anything it needs, and draw onto the
              canvas once things are clear — using only statuses that exist here. Nothing is saved
              until you press Save.
            </p>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-6 rounded-lg rounded-br-sm bg-[var(--chip-blue-bg)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--chip-blue-fg)]">
              {m.text}
            </div>
          ) : (
            <div key={i} className="mr-2">
              <div className="rounded-lg rounded-bl-sm border border-line bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-sub">
                {m.text}
              </div>
              {m.drew && (
                <p className="mt-1 pl-1 text-[11px] text-faint">
                  drawn on the canvas · ⌘Z to undo · press Save to keep it
                </p>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="mr-2 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-navy" /> thinking…
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="mt-3 shrink-0">
        <div className={`flex items-end gap-2 rounded-lg border border-line bg-surface p-2 ${frozen ? "opacity-60" : ""}`}>
          <textarea
            ref={box}
            rows={2}
            value={text}
            disabled={frozen || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={frozen ? "This workflow is frozen" : "Ask, or describe the flow… (Enter to send)"}
            className="min-h-0 flex-1 resize-none border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
          />
          <button onClick={send} disabled={frozen || busy || !text.trim()}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-navy text-white disabled:opacity-40">
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
