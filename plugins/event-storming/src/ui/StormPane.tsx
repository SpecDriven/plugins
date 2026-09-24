// The Event Storming tab: a sidebar list of the data repo's boards, and the
// wall one of them is on — an unbounded, pannable, zoomable surface of
// sticky notes in the classic legend's colours, the areas drawn round them
// and the arrows between them, read left to right as time. Every gesture is
// an edit of the board file (mutations.ts), from which the wall is derived
// again (flow.ts); the file autosaves through its document like a page
// does, and Undo walks back through the files the wall passed through.

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type OnNodeDrag,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import {
  Check,
  ClipboardCopy,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  Flag,
  Link,
  Maximize,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  Redo2,
  SquareDashed,
  StickyNote,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Breadcrumbs,
  createPromiseQueue,
  Menu,
  SaveIndicator,
  toast,
  Tooltip,
  type ConfirmOptions,
  type Crumb,
  type PromptOptions,
} from "@specdriven/client";
import { stormOutline } from "../storm/outline";
import { serializeStormFile } from "../storm/serialize";
import { STICKY, STICKY_KINDS, type StickyKind, type StormFile } from "../storm/types";
import type { StormListing, StormView } from "../server/storms";
import { stormLink } from "../route";
import { stickyBounds, toFlow, type WallNode } from "./flow";
import {
  addArea,
  addSticky,
  connect,
  duplicate,
  GRID,
  moveTo,
  removeIds,
  setName,
  updateArea,
  updateSticky,
} from "./mutations";
import { nodeTypes, WallActionsContext, type WallActions } from "./nodes";
import { stormExportUrl, storms, stormStem, useStorms } from "./store";

type Prompt = (opts: PromptOptions) => Promise<string | null>;
type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

/** Autosave settles this long after the last change. */
const SAVE_DELAY_MS = 600;
/** How many boards back Undo can go. */
const HISTORY = 100;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** A click that the browser should not follow — the app navigates instead. */
function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** Where typing belongs to a field rather than to the wall. */
function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** React Flow's own light/dark: the app's explicit theme when there is one, the system's otherwise. */
type ColorMode = "light" | "dark" | "system";

function useColorMode(): ColorMode {
  const read = (): ColorMode => {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : "system";
  };
  const [mode, setMode] = useState<ColorMode>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

/** Whether the legend is open, remembered on this device. */
function useLegendOpen(): [boolean, (open: boolean) => void] {
  const key = "specdriven.eventStorming.legend";
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "closed";
    } catch {
      return true;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(key, next ? "open" : "closed");
    } catch {
      // A private window: the legend just forgets.
    }
  };
  return [open, set];
}

/** A small square of a kind's paper, as the legend and the buttons show it. */
function Swatch({ kind }: { kind: StickyKind }) {
  return (
    <span
      className={`storm-swatch storm-swatch-${kind}`}
      style={{ ["--paper" as string]: STICKY[kind].color }}
      aria-hidden="true"
    />
  );
}

export interface StormPaneProps {
  fileName: string;
  repoCrumb: Crumb;
  /** Bumped by the app's reload tick: a board with nothing unsaved re-reads. */
  reloadKey: number;
  prompt: Prompt;
  confirm: Confirm;
  /** Start a code gen session over this board; absent while code gen is off. */
  onStartSession?: () => void;
  onCopyLink: (path: string) => void;
  copied: string | null;
  /** The board is gone (deleted, or a stale link): leave the pane. */
  onClosed: () => void;
  /**
   * The wall's pending save. The app calls `flush` before switching data
   * repo: it lands what is unsaved in the folder it was drawn in and then
   * seals the pane, so no later save reaches the new folder.
   */
  onSaveHandle?: (handle: { flush: () => Promise<void> } | null) => void;
}

export function StormPane(props: StormPaneProps) {
  return (
    <ReactFlowProvider>
      <Wall {...props} />
    </ReactFlowProvider>
  );
}

function Wall({
  fileName,
  repoCrumb,
  reloadKey,
  prompt,
  confirm,
  onStartSession,
  onCopyLink,
  copied,
  onClosed,
  onSaveHandle,
}: StormPaneProps) {
  const flow = useReactFlow<WallNode, Edge>();
  const colorMode = useColorMode();
  const [legendOpen, setLegendOpen] = useLegendOpen();

  const [file, setFile] = useState<StormFile | null>(null);
  const fileRef = useRef<StormFile | null>(null);
  fileRef.current = file;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** The file as the server last confirmed it — what "dirty" is measured against. */
  const savedRef = useRef<StormFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<StickyKind>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  /** Undo's files, most recent last, and Redo's. */
  const past = useRef<StormFile[]>([]);
  const future = useRef<StormFile[]>([]);
  const [, setHistoryTick] = useState(0);
  /** A sticky just put on the wall and not yet written on: blank, it goes again. */
  const fresh = useRef<{ id: string; before: StormFile } | null>(null);
  /** Nodes to select once the wall has them. */
  const pendingSelect = useRef<string[] | null>(null);
  /** The pointer on the wall, in the wall's coordinates — where a key adds a sticky. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const wallRef = useRef<HTMLDivElement>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<WallNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  /** PUTs go through one queue so a slow autosave cannot last-write-wins a later edit. */
  const saveQueue = useRef(createPromiseQueue());
  /** Bumped per load and on a successful save, so an older GET cannot apply its snapshot. */
  const loadGen = useRef(0);
  /** Set once the pane has said its last word for this data folder. */
  const closed = useRef(false);

  /** Nodes and edges from the file, keeping what is selected selected. */
  const derive = useCallback(
    (next: StormFile, hiddenKinds: ReadonlySet<StickyKind>) => {
      const derived = toFlow(next, hiddenKinds);
      const wanted = pendingSelect.current;
      pendingSelect.current = null;
      setNodes((prev) => {
        const keep = wanted ? new Set(wanted) : new Set(prev.filter((n) => n.selected).map((n) => n.id));
        return derived.nodes.map((n) => ({ ...n, selected: keep.has(n.id) }));
      });
      setEdges((prev) => {
        const keep = wanted ? new Set<string>() : new Set(prev.filter((e) => e.selected).map((e) => e.id));
        return derived.edges.map((e) => ({ ...e, selected: keep.has(e.id) }));
      });
      if (wanted) setSelected(wanted);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (file) derive(file, hidden);
  }, [file, hidden, derive]);

  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  // Load, and re-read on the reload tick while nothing is unsaved.
  const load = useCallback(async (): Promise<void> => {
    const gen = ++loadGen.current;
    const res = await fetch(`/api/storms/${encodeURIComponent(fileName)}`);
    const data = (await res.json().catch(() => ({}))) as StormView & { error?: string };
    if (gen !== loadGen.current) return;
    if (!res.ok || !data.file) {
      if (res.status === 404) {
        toast.error(`Board "${fileName}" not found — the link may be stale.`);
        onClosedRef.current();
        return;
      }
      setError(data.error ?? `Could not open the board "${fileName}"`);
      return;
    }
    setError(null);
    const current = fileRef.current;
    if (current && savedRef.current && current !== savedRef.current) return; // unsaved edits
    if (current && serializeStormFile(current) === serializeStormFile(data.file)) return;
    // Someone else's edit arrived: Undo must not walk back over it.
    if (current) {
      past.current = [];
      future.current = [];
      setHistoryTick((t) => t + 1);
    }
    savedRef.current = data.file;
    fileRef.current = data.file;
    setFile(data.file);
    setDirty(false);
  }, [fileName]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /** One save: the file as it is when this job runs; the server's normalized copy is adopted unless more was drawn meanwhile. */
  const save = useCallback(async (): Promise<void> => {
    if (closed.current) return;
    await saveQueue.current.run(async () => {
      const sent = fileRef.current;
      if (closed.current || !sent || sent === savedRef.current) return;
      setSaving(true);
      try {
        const res = await fetch(`/api/storms/${encodeURIComponent(fileName)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: sent }),
        });
        const data = (await res.json().catch(() => ({}))) as StormView & { error?: string };
        if (!res.ok || !data.file) {
          toast.error(data.error ?? "Could not save the board");
          return;
        }
        loadGen.current += 1;
        savedRef.current = data.file;
        if (fileRef.current === sent) {
          fileRef.current = data.file;
          setFile(data.file);
          setDirty(false);
        }
        setSavedAt(Date.now());
        void storms.load();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSaving(false);
      }
    });
  }, [fileName]);

  const saveRef = useRef(save);
  saveRef.current = save;
  /** Everything the wall still holds, landed in the folder it was drawn in; then the pane is sealed. */
  const flush = useCallback(async (): Promise<void> => {
    try {
      for (let pass = 0; pass < 5; pass++) {
        await saveRef.current();
        await saveQueue.current.idle();
        const held = fileRef.current;
        if (!held || held === savedRef.current) break;
      }
    } finally {
      closed.current = true;
    }
  }, []);
  useEffect(() => {
    onSaveHandle?.({ flush });
    return () => onSaveHandle?.(null);
  }, [flush, onSaveHandle]);
  useEffect(() => {
    if (!file || file === savedRef.current) return;
    const id = window.setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [file]);
  // Leaving the pane with an edit still pending: it goes out now.
  useEffect(() => () => void saveRef.current(), []);

  /** The board after a gesture, remembered for Undo; null means refused. */
  const apply = useCallback(
    (next: StormFile | null, refused = "That is not allowed here.") => {
      const current = fileRef.current;
      if (next === null || !current) {
        if (next === null) toast.error(refused);
        if (current) derive(current, hidden);
        return;
      }
      if (next === current) return;
      past.current = [...past.current.slice(-(HISTORY - 1)), current];
      future.current = [];
      fileRef.current = next;
      setFile(next);
      setDirty(true);
      setHistoryTick((t) => t + 1);
    },
    [derive, hidden],
  );

  /** Put a board back without remembering the step — Undo, Redo, a blank sticky taken away. */
  const restore = (next: StormFile) => {
    fileRef.current = next;
    setFile(next);
    setDirty(true);
    setEditing(null);
    setHistoryTick((t) => t + 1);
  };

  const undo = () => {
    const previous = past.current.at(-1);
    if (!previous || !fileRef.current) return;
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, fileRef.current];
    fresh.current = null;
    restore(previous);
  };

  const redo = () => {
    const next = future.current.at(-1);
    if (!next || !fileRef.current) return;
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, fileRef.current];
    restore(next);
  };

  /** The middle of what the wall shows, in the wall's coordinates. */
  const centre = (): { x: number; y: number } => {
    const box = wallRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
  };

  /** A new sticky of a kind at a point (the pointer, or the middle), open for writing. */
  const add = (kind: StickyKind, at?: { x: number; y: number }) => {
    const current = fileRef.current;
    if (!current) return;
    setHidden((h) => {
      if (!h.has(kind)) return h;
      const next = new Set(h);
      next.delete(kind);
      return next;
    });
    const made = addSticky(current, kind, at ?? pointer.current ?? centre());
    fresh.current = { id: made.id, before: current };
    pendingSelect.current = [made.id];
    apply(made.file);
    setEditing(made.id);
  };

  const newArea = () => {
    const current = fileRef.current;
    if (!current) return;
    const made = addArea(current, centre());
    pendingSelect.current = [made.id];
    apply(made.file);
    setEditing(made.id);
  };

  /** A blank sticky just added goes again, and Undo forgets it was ever there. */
  const dropFresh = (id: string): boolean => {
    const f = fresh.current;
    fresh.current = null;
    if (!f || f.id !== id || past.current.at(-1) !== f.before) return false;
    past.current = past.current.slice(0, -1);
    restore(f.before);
    return true;
  };

  const actions = useMemo<WallActions>(
    () => ({
      editing,
      startEdit: (id) => setEditing(id),
      commitText: (id, text) => {
        setEditing(null);
        const current = fileRef.current;
        if (!current) return;
        const sticky = current.stickies.find((s) => s.id === id);
        if (sticky) {
          if (!text && dropFresh(id)) return;
          fresh.current = null;
          if (sticky.text !== text) apply(updateSticky(current, id, { text }));
          return;
        }
        const area = current.areas.find((a) => a.id === id);
        if (area && area.label !== text) apply(updateArea(current, id, { label: text }));
      },
      cancelEdit: () => {
        const id = editing;
        setEditing(null);
        if (id) dropFresh(id);
      },
      resizeArea: (id, box) => {
        if (fileRef.current) apply(updateArea(fileRef.current, id, box));
      },
    }),
    // dropFresh and restore only touch refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, apply],
  );

  // ---- React Flow handlers ----

  const onSelectionChange = useCallback(({ nodes: picked, edges: arrows }: OnSelectionChangeParams) => {
    setSelected([...picked.map((n) => n.id), ...arrows.map((e) => e.id)]);
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag<WallNode>>(
    (_e, _node, dragged) => {
      const current = fileRef.current;
      if (!current) return;
      apply(moveTo(current, new Map(dragged.map((n) => [n.id, n.position]))));
    },
    [apply],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const current = fileRef.current;
      if (current) apply(connect(current, c.source, c.target), "Those two are joined already.");
    },
    [apply],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: cut }: { nodes: WallNode[]; edges: Edge[] }) => {
      const current = fileRef.current;
      if (!current || (gone.length === 0 && cut.length === 0)) return;
      apply(removeIds(current, [...gone.map((n) => n.id), ...cut.map((e) => e.id)]));
      setSelected([]);
    },
    [apply],
  );

  // ---- What the selection bar does ----

  const selectedStickies = useMemo(
    () => (file ? file.stickies.filter((s) => selected.includes(s.id)) : []),
    [file, selected],
  );
  const selectedAreas = useMemo(() => (file ? file.areas.filter((a) => selected.includes(a.id)) : []), [file, selected]);

  const recolour = (kind: StickyKind) => {
    let current = fileRef.current;
    if (!current) return;
    for (const s of selectedStickies) current = updateSticky(current, s.id, { kind });
    apply(current);
  };

  const togglePivotal = () => {
    let current = fileRef.current;
    if (!current) return;
    const on = !selectedStickies.every((s) => s.pivotal);
    for (const s of selectedStickies) current = updateSticky(current, s.id, { pivotal: on });
    apply(current);
  };

  const duplicateSelection = () => {
    const current = fileRef.current;
    const ids = selected.filter((id) => current?.stickies.some((s) => s.id === id) || current?.areas.some((a) => a.id === id));
    if (!current || ids.length === 0) return;
    const made = duplicate(current, ids);
    pendingSelect.current = made.ids;
    apply(made.file);
  };

  const deleteSelection = () => {
    const current = fileRef.current;
    if (!current || selected.length === 0) return;
    apply(removeIds(current, selected));
    setSelected([]);
  };

  // ---- The wall's own keys and pointer ----

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || typingInField(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateSelection();
    } else if (!mod && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      add(STICKY_KINDS[Number(e.key) - 1]!);
    } else if (e.key === "Enter" && selected.length === 1) {
      const id = selected[0]!;
      if (file?.stickies.some((s) => s.id === id) || file?.areas.some((a) => a.id === id)) {
        e.preventDefault();
        setEditing(id);
      }
    }
  };

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    pointer.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
  };

  // A double-click on the bare wall puts an event there — the workshop's first move.
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
    add("event", flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  // ---- The board itself ----

  const rename = async () => {
    if (!fileRef.current) return;
    const name = await prompt({ title: "Rename board", initial: fileRef.current.name, confirmLabel: "Rename" });
    if (name && name !== fileRef.current.name) apply(setName(fileRef.current, name));
  };

  const copyOutline = () => {
    if (!fileRef.current) return;
    void navigator.clipboard
      .writeText(stormOutline(fileRef.current))
      .then(() => toast.success("Copied the board's timeline as Markdown."))
      .catch(() => toast.error("Could not copy to the clipboard."));
  };

  const remove = async () => {
    if (!fileRef.current) return;
    const ok = await confirm({
      title: "Delete board",
      body: `“${fileRef.current.name}” will be deleted, committed and pushed. This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    savedRef.current = fileRef.current; // nothing left to save
    const message = await storms.remove(fileName);
    if (message !== null) {
      toast.success(`Deleted the board${message ? ` — ${message}` : ""}.`);
      onClosed();
    }
  };

  const counts = useMemo(() => {
    const out: Partial<Record<StickyKind, number>> = {};
    for (const s of file?.stickies ?? []) out[s.kind] = (out[s.kind] ?? 0) + 1;
    return out;
  }, [file]);

  const bounds = useMemo(() => (file ? stickyBounds(file) : null), [file]);

  if (error) {
    return (
      <div className="storm-pane">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!file) return <p className="hint">Loading the board…</p>;

  const link = stormLink(fileName);
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;
  const allEvents = selectedStickies.length > 0 && selectedStickies.every((s) => s.kind === "event");

  return (
    <div className="storm-pane">
      <header className="editor-bar page-header">
        <Breadcrumbs
          items={[repoCrumb, { label: "Event Storming" }]}
          tail={<span className="crumb current plain">{file.name || stormStem(fileName)}</span>}
        />
        <div className="editor-actions page-actions">
          <SaveIndicator saving={saving} savedAt={savedAt} dirty={dirty} />
          <Tooltip label={`Undo (${MOD}Z)`}>
            <button type="button" className="ibtn" aria-label="Undo" disabled={!canUndo} onClick={undo}>
              <Undo2 size={15} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label={`Redo (${MOD}⇧Z)`}>
            <button type="button" className="ibtn" aria-label="Redo" disabled={!canRedo} onClick={redo}>
              <Redo2 size={15} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label={copied === link ? "Copied" : "Copy link"}>
            <button type="button" className="ibtn" aria-label="Copy link" onClick={() => onCopyLink(link)}>
              {copied === link ? <Check size={15} aria-hidden="true" /> : <Link size={15} aria-hidden="true" />}
            </button>
          </Tooltip>
          <Tooltip label="Download the board as JSON">
            <a className="ibtn" href={stormExportUrl(fileName)} download aria-label="Download">
              <Download size={15} aria-hidden="true" />
            </a>
          </Tooltip>
          <span className="chip-anchor storm-menu-anchor">
            <button
              type="button"
              className="ibtn"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Ellipsis size={15} aria-hidden="true" />
            </button>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              label="Board actions"
              className="chip-menu chip-menu-end"
              containerSelector=".storm-menu-anchor"
              items={[
                { id: "rename", label: "Rename", icon: <Pencil size={13} />, onSelect: () => void rename() },
                {
                  id: "outline",
                  label: "Copy timeline as Markdown",
                  icon: <ClipboardCopy size={13} />,
                  onSelect: copyOutline,
                },
                ...(onStartSession
                  ? [
                      {
                        id: "session",
                        label: "Start AI session over this board",
                        icon: <Play size={13} />,
                        onSelect: () => onStartSession(),
                      },
                    ]
                  : []),
                { id: "delete", label: "Delete board", icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove() },
              ]}
            />
          </span>
          <Tooltip label={legendOpen ? "Hide the legend" : "Show the legend"}>
            <button
              type="button"
              className="ibtn"
              aria-label={legendOpen ? "Hide the legend" : "Show the legend"}
              aria-pressed={legendOpen}
              onClick={() => setLegendOpen(!legendOpen)}
            >
              {legendOpen ? <PanelRightClose size={15} aria-hidden="true" /> : <PanelRightOpen size={15} aria-hidden="true" />}
            </button>
          </Tooltip>
        </div>
      </header>
      <div className={`storm-body${legendOpen ? "" : " no-legend"}`}>
        <div
          ref={wallRef}
          className="storm-wall"
          tabIndex={0}
          aria-label="Event Storming wall"
          onKeyDown={onKeyDown}
          onMouseMove={onMouseMove}
          onMouseLeave={() => (pointer.current = null)}
          onDoubleClick={onDoubleClick}
        >
          <WallActionsContext.Provider value={actions}>
            <ReactFlow<WallNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onSelectionChange={onSelectionChange}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              onDelete={onDelete}
              deleteKeyCode={editing ? null : ["Backspace", "Delete"]}
              multiSelectionKeyCode={["Meta", "Control", "Shift"]}
              zoomOnDoubleClick={false}
              colorMode={colorMode}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.1}
              maxZoom={2}
              snapToGrid
              snapGrid={[GRID, GRID]}
              elevateNodesOnSelect={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={GRID * 2} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => (n.type === "sticky" ? STICKY[(n as WallNode & { type: "sticky" }).data.sticky.kind].color : "transparent")}
                nodeStrokeWidth={2}
              />
              {bounds && (
                <ViewportPortal>
                  <div
                    className="storm-timeline"
                    style={{
                      transform: `translate(${bounds.x}px, ${bounds.y - 56}px)`,
                      width: Math.max(bounds.right - bounds.x + 64, 240),
                    }}
                    aria-hidden="true"
                  >
                    <span>Time</span>
                  </div>
                </ViewportPortal>
              )}
              {(selectedStickies.length > 0 || selectedAreas.length > 0) && !editing && (
                <Panel position="top-center" className="storm-selection" aria-label="Selection">
                  {selectedStickies.length > 0 && (
                    <>
                      <span className="storm-selection-swatches" role="group" aria-label="Kind">
                        {STICKY_KINDS.map((kind) => (
                          <Tooltip key={kind} label={`Make ${selectedStickies.length === 1 ? "it" : "them"} ${STICKY[kind].label.toLowerCase()}`}>
                            <button
                              type="button"
                              className={`storm-kind-btn${selectedStickies.every((s) => s.kind === kind) ? " on" : ""}`}
                              aria-label={STICKY[kind].label}
                              aria-pressed={selectedStickies.every((s) => s.kind === kind)}
                              onClick={() => recolour(kind)}
                            >
                              <Swatch kind={kind} />
                            </button>
                          </Tooltip>
                        ))}
                      </span>
                      {allEvents && (
                        <Tooltip label="A pivotal event: the story changes phase after it">
                          <button
                            type="button"
                            className={`storm-bar-btn${selectedStickies.every((s) => s.pivotal) ? " on" : ""}`}
                            aria-pressed={selectedStickies.every((s) => s.pivotal)}
                            onClick={togglePivotal}
                          >
                            <Flag size={13} aria-hidden="true" /> Pivotal
                          </button>
                        </Tooltip>
                      )}
                    </>
                  )}
                  {selected.length === 1 && (
                    <Tooltip label="Write on it (Enter)">
                      <button type="button" className="storm-bar-btn" aria-label="Edit" onClick={() => setEditing(selected[0]!)}>
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip label={`Duplicate (${MOD}D)`}>
                    <button type="button" className="storm-bar-btn" aria-label="Duplicate" onClick={duplicateSelection}>
                      <Copy size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Delete (Backspace)">
                    <button type="button" className="storm-bar-btn danger" aria-label="Delete" onClick={deleteSelection}>
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </Panel>
              )}
            </ReactFlow>
          </WallActionsContext.Provider>
          {file.stickies.length === 0 && file.areas.length === 0 && (
            <div className="storm-empty">
              <StickyNote size={28} aria-hidden="true" />
              <p>
                An empty wall. Start as the workshop does: double-click anywhere to stick a domain event, one
                thing that happened per sticky, in the past tense.
              </p>
            </div>
          )}
        </div>
        {legendOpen && (
          <Legend
            counts={counts}
            hidden={hidden}
            onAdd={(kind) => add(kind, centre())}
            onAddArea={newArea}
            onToggle={(kind) =>
              setHidden((h) => {
                const next = new Set(h);
                if (next.has(kind)) next.delete(kind);
                else next.add(kind);
                return next;
              })
            }
            onFit={() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 200 })}
          />
        )}
      </div>
    </div>
  );
}

// ---- The legend: what each colour means, and a sticky of it ----

const STEPS: [string, string][] = [
  ["Chaotic exploration", "Everyone writes the domain events they know, orange, anywhere on the wall."],
  ["Enforce the timeline", "Put them in the order they happen, left to right; duplicates go."],
  ["Pivotal events", "Mark the few events after which the story changes phase; draw areas round the phases."],
  ["People and systems", "Add the actors and external systems the events involve."],
  ["Hotspots", "Stick a hotspot wherever there is a question, a risk or a disagreement."],
  ["Commands and policies", "What causes each event: a command someone issues, or a policy reacting to another event."],
  ["Read models and aggregates", "What people look at to decide, and what decides — then the bounded contexts."],
];

function Legend({
  counts,
  hidden,
  onAdd,
  onAddArea,
  onToggle,
  onFit,
}: {
  counts: Partial<Record<StickyKind, number>>;
  hidden: ReadonlySet<StickyKind>;
  onAdd: (kind: StickyKind) => void;
  onAddArea: () => void;
  onToggle: (kind: StickyKind) => void;
  onFit: () => void;
}) {
  return (
    <aside className="storm-legend" aria-label="Legend">
      <div className="storm-legend-head">
        <span className="storm-legend-title">Legend</span>
        <Tooltip label="Fit the board in view">
          <button type="button" className="ibtn" aria-label="Fit the board in view" onClick={onFit}>
            <Maximize size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <ul className="storm-legend-list">
        {STICKY_KINDS.map((kind, i) => (
          <li key={kind} className={hidden.has(kind) ? "off" : undefined}>
            <button
              type="button"
              className="storm-legend-add"
              title={`${STICKY[kind].meaning}\nAdds one (key ${i + 1}).`}
              onClick={() => onAdd(kind)}
            >
              <Swatch kind={kind} />
              <span className="storm-legend-name">{STICKY[kind].label}</span>
              <kbd>{i + 1}</kbd>
            </button>
            <span className="storm-legend-count">{counts[kind] ?? 0}</span>
            <Tooltip label={hidden.has(kind) ? `Show ${STICKY[kind].plural.toLowerCase()}` : `Hide ${STICKY[kind].plural.toLowerCase()}`}>
              <button
                type="button"
                className="ibtn storm-legend-eye"
                aria-label={hidden.has(kind) ? `Show ${STICKY[kind].plural}` : `Hide ${STICKY[kind].plural}`}
                aria-pressed={!hidden.has(kind)}
                onClick={() => onToggle(kind)}
              >
                {hidden.has(kind) ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
              </button>
            </Tooltip>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="storm-legend-add"
            title="A frame round stickies: a bounded context, a swimlane or a phase."
            onClick={onAddArea}
          >
            <SquareDashed size={16} className="storm-area-icon" aria-hidden="true" />
            <span className="storm-legend-name">Area</span>
          </button>
        </li>
      </ul>
      <div className="storm-legend-tips">
        <p>
          <Plus size={11} aria-hidden="true" /> Double-click the wall for an event, or press 1–9 for a sticky at the
          pointer.
        </p>
        <p>Double-click a sticky or Enter to write on it. Drag from its right dot to another to draw an arrow.</p>
        <p>Shift-drag to select many; {MOD}D duplicates, {MOD}Z undoes.</p>
      </div>
      <details className="storm-steps">
        <summary>Running the workshop</summary>
        <ol>
          {STEPS.map(([title, body]) => (
            <li key={title}>
              <strong>{title}.</strong> {body}
            </li>
          ))}
        </ol>
      </details>
    </aside>
  );
}

// ---- No board open: what Event Storming is, and a way to start ----

export function Welcome({ onCreate, onExample }: { onCreate: () => void; onExample: () => void }) {
  return (
    <div className="storm-welcome">
      <StickyNote size={32} aria-hidden="true" />
      <h1>Event Storming</h1>
      <p>
        A wall of sticky notes for exploring a domain together: the things that happen in it as orange domain
        events on a timeline, then what causes them and who is involved, each in its own colour.
      </p>
      <ul className="storm-welcome-legend">
        {STICKY_KINDS.map((kind) => (
          <li key={kind}>
            <Swatch kind={kind} />
            <span>
              <strong>{STICKY[kind].label}</strong> — {STICKY[kind].meaning}
            </span>
          </li>
        ))}
      </ul>
      <div className="storm-welcome-actions">
        <button type="button" className="primary" onClick={onCreate}>
          New board
        </button>
        <button type="button" onClick={onExample}>
          Start from an example
        </button>
      </div>
    </div>
  );
}

// ---- The sidebar: the boards, listed ----

export interface StormsSidebarProps {
  active: string | null;
  prompt: Prompt;
  confirm: Confirm;
  onNavigate: (fileName: string, opts?: { push?: boolean }) => void;
  onCopyLink: (path: string) => void;
  /** The open board was deleted from the list. */
  onClosed: (fileName: string) => void;
}

function groups(list: StormListing[]): { dir: string; storms: StormListing[] }[] {
  const map = new Map<string, StormListing[]>();
  for (const storm of list) {
    const dir = storm.fileName.split("/").slice(1, -1).join("/");
    const bucket = map.get(dir) ?? [];
    bucket.push(storm);
    map.set(dir, bucket);
  }
  return [...map]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, storms: list }));
}

/** "12 events · 3 hotspots" — the row's tooltip. */
function summary(storm: StormListing): string {
  const parts = STICKY_KINDS.filter((k) => storm.counts[k]).map((k) => {
    const n = storm.counts[k]!;
    return `${n} ${(n === 1 ? STICKY[k].label : STICKY[k].plural).toLowerCase()}`;
  });
  return parts.length > 0 ? parts.join(" · ") : "empty";
}

/** Ask for a name and create a board — empty, from the example, or from an import. */
export async function newBoard(
  prompt: Prompt,
  seed: { example: true } | { import: unknown } | Record<string, never> = {},
  initial = "",
): Promise<string | null> {
  const name = await prompt({
    title: "import" in seed ? "Import board" : "New Event Storming board",
    hint: "import" in seed
      ? "A board downloaded from here, or a JSON file saved by the Event Storm web app."
      : "Use folder/name to create inside a subfolder of storms.",
    initial: initial || ("example" in seed ? "Online shop" : ""),
    placeholder: "Order fulfilment",
    confirmLabel: "import" in seed ? "Import" : "Create board",
  });
  if (!name) return null;
  return storms.create(name, seed);
}

export function StormsSidebar({ active, prompt, confirm, onNavigate, onCopyLink, onClosed }: StormsSidebarProps) {
  const store = useStorms();
  const [menu, setMenu] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = async () => {
    const fileName = await newBoard(prompt);
    if (fileName) onNavigate(fileName, { push: true });
  };

  const imported = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await picked.text());
    } catch {
      toast.error("That file is not JSON.");
      return;
    }
    const guess =
      (parsed !== null && typeof parsed === "object" && typeof (parsed as { name?: unknown }).name === "string"
        ? (parsed as { name: string }).name
        : "") || picked.name.replace(/(\.storm)?\.json$/i, "");
    const fileName = await newBoard(prompt, { import: parsed }, guess);
    if (fileName) onNavigate(fileName, { push: true });
  };

  const remove = async (storm: StormListing) => {
    const ok = await confirm({
      title: "Delete board",
      body: `“${storm.name}” will be deleted, committed and pushed. This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const message = await storms.remove(storm.fileName);
    if (message === null) return;
    toast.success(`Deleted “${storm.name}”${message ? ` — ${message}` : ""}.`);
    if (active === storm.fileName) onClosed(storm.fileName);
  };

  const row = (storm: StormListing, nested: boolean): ReactNode => (
    <div key={storm.fileName} className={`page-row${nested ? " nested" : ""}`}>
      <a
        href={stormLink(storm.fileName)}
        className={`page-entry${storm.fileName === active ? " active" : ""}`}
        title={`${storm.name} · ${summary(storm)}`}
        aria-current={storm.fileName === active ? "page" : undefined}
        onClick={(e) => spaClick(e, () => onNavigate(storm.fileName, { push: true }))}
      >
        {storm.name}
      </a>
      <span className="tree-row-menu">
        <Tooltip label="More actions">
          <button
            type="button"
            className="tree-menu-btn"
            aria-label={`Menu for ${storm.name}`}
            aria-haspopup="menu"
            aria-expanded={menu === storm.fileName}
            onClick={() => setMenu((m) => (m === storm.fileName ? null : storm.fileName))}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <Menu
          open={menu === storm.fileName}
          onClose={() => setMenu(null)}
          label={`Menu for ${storm.name}`}
          className="tree-menu"
          containerSelector=".tree-row-menu"
          items={[
            { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => onCopyLink(stormLink(storm.fileName)) },
            {
              id: "export",
              label: "Download JSON",
              icon: <Download size={13} />,
              onSelect: () => window.open(stormExportUrl(storm.fileName), "_blank"),
            },
            { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove(storm) },
          ]}
        />
      </span>
    </div>
  );

  return (
    <div
      className="side-panel page-list"
      role="tabpanel"
      id="side-panel-event-storming"
      aria-labelledby="side-tab-event-storming"
    >
      <div className="sidebar-actions">
        <button onClick={() => void create()}>+ New board</button>
        <Tooltip label="Import a board from JSON">
          <button className="storm-import" aria-label="Import" onClick={() => fileInput.current?.click()}>
            <Upload size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void imported(e)} />
      </div>
      <div className="page-rows">
        {store.error && <p className="error">{store.error}</p>}
        {groups(store.storms).map(({ dir, storms: list }) => (
          <div key={dir || "."}>
            {dir && <div className="page-group">{dir}</div>}
            {list.map((storm) => row(storm, dir !== ""))}
          </div>
        ))}
        {store.loaded && store.storms.length === 0 && <p className="empty">No boards yet</p>}
      </div>
    </div>
  );
}
