// The Models tab (roadmap/support-event-modeling.md): a sidebar list of the
// data repo's Event Models, and the canvas one of them is drawn on — swim
// lanes across, slice bands down, cards in the cells, arrows between them —
// with an inspector for whatever is selected. The canvas is React Flow;
// the model is the file (src/model/types.ts). Every gesture is a mutation
// of the file (mutations.ts), from which the nodes and edges are derived
// again (flow.ts), and the file autosaves through its document like a page
// does. React Flow rides in the plugin's bundle, which the app loads only
// while the plugin is on.

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type IsValidConnection,
  type OnNodeDrag,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import {
  Check,
  Download,
  Ellipsis,
  FileJson,
  LayoutGrid,
  Link,
  Play,
  Plus,
  Trash2,
  Upload,
  UserRound,
  Workflow,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { serializeModelFile } from "../model/serialize";
import {
  ELEMENT_TYPES,
  findElement,
  type ElementType,
  type ModelFile,
} from "../model/types";
import type { ModelListing, ModelView } from "../server/models";
import {
  Breadcrumbs,
  createPromiseQueue,
  Menu,
  SaveIndicator,
  toast,
  Tooltip,
  type ConfirmOptions,
  type Crumb,
  type FeatureListing,
  type PromptOptions,
  type ProjectMember,
} from "@specdriven/client";
import { modelLink } from "../route";
import { Inspector } from "./Inspector";
import { SliceActionsContext, type SliceActions } from "./context";
import { dropTarget } from "./geometry";
import {
  edgeEnds,
  elementNodeId,
  nodeIdOf,
  selectionOf,
  toFlow,
  type CanvasNode,
  type Selection,
} from "./flow";
import { modelExportUrl, modelStem, models, useModels } from "./models";
import {
  addElement,
  addLane,
  addSlice,
  autoLayoutFile,
  canDraw,
  connect,
  disconnect,
  moveElement,
  removeElement,
  setAssigned,
  setName,
  setSliceLink,
  typeLabel,
} from "./mutations";
import { nodeTypes } from "./nodes";

type Prompt = (opts: PromptOptions) => Promise<string | null>;
type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

/** A click that the browser should not follow — the app navigates instead. */
function spaClick(e: MouseEvent, go: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go();
}

/** Autosave settles this long after the last change. */
const SAVE_DELAY_MS = 600;

const TYPE_HINT: Record<ElementType, string> = {
  SCREEN: "Cart page",
  COMMAND: "Add item",
  EVENT: "Item added",
  READMODEL: "Cart items",
  AUTOMATION: "Reserve stock",
};

/**
 * React Flow's own light/dark: the app's explicit theme choice when there is
 * one (specs/ui.spec.md "Settings"), otherwise the system's.
 */
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

export interface ModelsPaneProps {
  fileName: string;
  features: FeatureListing[];
  members: ProjectMember[];
  assignments: boolean;
  repoCrumb: Crumb;
  /** Bumped by the app's reload tick: a model with nothing unsaved re-reads. */
  reloadKey: number;
  prompt: Prompt;
  confirm: Confirm;
  onOpenFeature: (fileName: string) => void;
  /**
   * A slice scaffolded its feature file: the app re-reads the listing and
   * opens the new feature.
   */
  onFeatureCreated: (fileName: string) => void | Promise<void>;
  /** Start a code gen session over this model; absent while code gen is off. */
  onStartSession?: () => void;
  onCopyLink: (path: string) => void;
  copied: string | null;
  /** The model is gone (deleted, or a stale link): leave the pane. */
  onClosed: () => void;
  /**
   * The canvas's pending save. The app calls `flush` before switching data
   * repo: it lands what is unsaved in the folder it was drawn in and then
   * seals the pane, so neither a later tick nor the unmount save can write
   * the old model into the new folder.
   */
  onSaveHandle?: (handle: { flush: () => Promise<void> } | null) => void;
}

export function ModelsPane(props: ModelsPaneProps) {
  return (
    <ReactFlowProvider>
      <ModelCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ModelCanvas({
  fileName,
  features,
  members,
  assignments,
  repoCrumb,
  reloadKey,
  prompt,
  confirm,
  onOpenFeature,
  onFeatureCreated,
  onStartSession,
  onCopyLink,
  copied,
  onClosed,
  onSaveHandle,
}: ModelsPaneProps) {
  const [file, setFile] = useState<ModelFile | null>(null);
  const fileRef = useRef<ModelFile | null>(null);
  fileRef.current = file;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** The file as the server last confirmed it — what "dirty" is measured against. */
  const savedRef = useRef<ModelFile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  /** A card just added: selected once the canvas has it. */
  const pendingSelect = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const colorMode = useColorMode();

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  /**
   * PUTs go through one queue so a slow autosave cannot last-write-wins a
   * later edit, a generate-feature link, or the unmount flush — the same
   * reason the page editor shares createPromiseQueue.
   */
  const saveQueue = useRef(createPromiseQueue());
  /** Bumped per load and on a successful save, so a GET that started
      earlier cannot apply a snapshot that predates the PUT. */
  const loadGen = useRef(0);
  /**
   * Set once the pane has said its last word for this data folder (the app
   * flushed it before switching repo). Every later save is a no-op: the
   * folder the canvas was drawn in is no longer the one a PUT would reach,
   * so the unmount save must not re-arm behind the flush.
   */
  const closed = useRef(false);

  /** Nodes and edges from the file, keeping what is selected selected. */
  const derive = useCallback(
    (next: ModelFile) => {
      const flow = toFlow(next);
      const wanted = pendingSelect.current;
      pendingSelect.current = null;
      setNodes((prev) => {
        const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
        if (wanted) {
          selected.clear();
          selected.add(wanted);
        }
        return flow.nodes.map((n) => ({ ...n, selected: selected.has(n.id) }));
      });
      setEdges((prev) => {
        const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
        return flow.edges.map((e) => ({ ...e, selected: selected.has(e.id) }));
      });
      if (wanted) setSelection(selectionOf(wanted));
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (file) derive(file);
  }, [file, derive]);

  // Read through a ref, so a new callback from a re-rendering parent does not
  // re-run the load below.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  // Load, and re-read on the reload tick while nothing is unsaved.
  const load = useCallback(async (): Promise<void> => {
    const gen = ++loadGen.current;
    const res = await fetch(`/api/models/${encodeURIComponent(fileName)}`);
    const data = (await res.json().catch(() => ({}))) as ModelView & { error?: string };
    if (gen !== loadGen.current) return;
    if (!res.ok || !data.file) {
      if (res.status === 404) {
        toast.error(`Model "${fileName}" not found — the link may be stale.`);
        onClosedRef.current();
        return;
      }
      setError(data.error ?? `Could not open the model "${fileName}"`);
      return;
    }
    setError(null);
    const current = fileRef.current;
    if (current && savedRef.current && current !== savedRef.current) return; // unsaved edits
    if (current && serializeModelFile(current) === serializeModelFile(data.file)) return;
    savedRef.current = data.file;
    fileRef.current = data.file;
    setFile(data.file);
    setDirty(false);
  }, [fileName]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /** One save: the file as it is when this job runs (not when it was
      queued); the server's normalized copy is adopted unless more was
      typed while the request was out. */
  const save = useCallback(async (): Promise<void> => {
    if (closed.current) return;
    await saveQueue.current.run(async () => {
      const sent = fileRef.current;
      if (closed.current || !sent || sent === savedRef.current) return;
      setSaving(true);
      try {
        const res = await fetch(`/api/models/${encodeURIComponent(fileName)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: sent }),
        });
        const data = (await res.json().catch(() => ({}))) as ModelView & { error?: string };
        if (!res.ok || !data.file) {
          toast.error(data.error ?? "Could not save the model");
          return;
        }
        // A GET that started before this PUT must not apply its snapshot.
        loadGen.current += 1;
        savedRef.current = data.file;
        if (fileRef.current === sent) {
          // Keep the ref in lockstep so an unmount flush that runs before
          // React re-renders sees the file as already saved.
          fileRef.current = data.file;
          setFile(data.file);
          setDirty(false);
        }
        setSavedAt(Date.now());
        void models.load();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setSaving(false);
      }
    });
  }, [fileName]);

  const saveRef = useRef(save);
  saveRef.current = save;
  /**
   * Everything the canvas still holds, landed in the folder it was drawn in,
   * and then the pane is sealed. An edit made while a PUT was out leaves the
   * file dirty again once that PUT lands, so this saves until nothing is
   * left rather than once — and the seal stops the unmount save from
   * enqueueing a PUT behind us, which would reach the *new* folder.
   */
  const flush = useCallback(async (): Promise<void> => {
    try {
      // Bounded: each pass sends whatever is dirty now, so a canvas nobody
      // is touching settles on the first or second. The cap only matters if
      // edits keep arriving during the switch, and then stopping is right.
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

  /** The file after a gesture; null means the gesture was refused. */
  const apply = useCallback(
    (next: ModelFile | null, refused = "That is not allowed here.") => {
      if (next === null) {
        toast.error(refused);
        if (fileRef.current) derive(fileRef.current);
        return;
      }
      setFile(next);
      setDirty(true);
    },
    [derive],
  );

  /** The slice a new card goes in: the selected one, the selected card's, or the last. */
  const targetSlice = (current: ModelFile): string | null => {
    if (selection?.kind === "slice") return selection.id;
    if (selection?.kind === "element") {
      return findElement(current.model, selection.id)?.slice.id ?? null;
    }
    return current.model.slices.at(-1)?.id ?? null;
  };

  const addCard = async (type: ElementType) => {
    const title = await prompt({
      title: `New ${typeLabel(type).toLowerCase()}`,
      placeholder: TYPE_HINT[type],
      confirmLabel: "Add",
    });
    if (!title || !fileRef.current) return;
    let current = fileRef.current;
    let sliceId = targetSlice(current);
    if (sliceId === null) {
      const made = addSlice(current, "Slice 1");
      current = made.file;
      sliceId = made.id;
    }
    const added = addElement(current, sliceId, type, title);
    pendingSelect.current = elementNodeId(added.id);
    apply(added.file);
  };

  const newSlice = async () => {
    const title = await prompt({
      title: "New slice",
      hint: "A vertical slice: one screen, command or automation with its events.",
      placeholder: "Add item to cart",
      confirmLabel: "Add slice",
    });
    if (!title || !fileRef.current) return;
    const made = addSlice(fileRef.current, title);
    pendingSelect.current = nodeIdOf({ kind: "slice", id: made.id });
    apply(made.file);
  };

  const newLane = async () => {
    const name = await prompt({
      title: "New events lane",
      hint: "One lane per stream or aggregate whose events it holds.",
      placeholder: "Inventory",
      confirmLabel: "Add lane",
    });
    if (!name || !fileRef.current) return;
    apply(addLane(fileRef.current, "EVENTS", name, name));
  };

  /**
   * The bridge to the specs: scaffold the slice's feature file on the
   * server — one scenario per Given / When / Then — from the model as
   * saved, so what is drawn goes out first. The link comes back into the
   * file here too, so the next autosave carries it rather than undoing it.
   */
  const generateFeature = async (sliceId: string) => {
    const slice = fileRef.current?.model.slices.find((s) => s.id === sliceId);
    if (!slice) return;
    const count = slice.specifications.length;
    const name = await prompt({
      title: "New feature file from the slice",
      hint:
        (count === 0
          ? "The slice has no Given / When / Then yet, so the feature starts with its heading alone. "
          : `One scenario per Given / When / Then — ${count} of them. `) +
        "Use folder/name to create inside a folder.",
      initial: slice.title,
      placeholder: "billing/Basic Quote",
      confirmLabel: "Create feature",
    });
    if (!name) return;
    await saveRef.current();
    try {
      const res = await fetch(
        `/api/models/${encodeURIComponent(fileName)}/slices/${encodeURIComponent(sliceId)}/feature`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) },
      );
      const data = (await res.json().catch(() => ({}))) as { fileName?: string; scenarios?: number; error?: string };
      if (!res.ok || !data.fileName) {
        toast.error(data.error ?? "Could not create the feature");
        return;
      }
      if (fileRef.current) apply(setSliceLink(fileRef.current, sliceId, data.fileName));
      toast.success(
        `Created ${data.fileName}${data.scenarios ? ` with ${data.scenarios} scenario${data.scenarios === 1 ? "" : "s"}` : ""}.`,
      );
      await onFeatureCreated(data.fileName);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const sliceActions = useMemo<SliceActions>(() => ({ openFeature: onOpenFeature }), [onOpenFeature]);

  const rename = async () => {
    if (!fileRef.current) return;
    const name = await prompt({
      title: "Rename model",
      initial: fileRef.current.name,
      confirmLabel: "Rename",
    });
    if (name && name !== fileRef.current.name) apply(setName(fileRef.current, name));
  };

  const remove = async () => {
    if (!fileRef.current) return;
    const ok = await confirm({
      title: "Delete model",
      body: `“${fileRef.current.name}” will be deleted, committed and pushed. This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    savedRef.current = fileRef.current; // nothing left to save
    const message = await models.remove(fileName);
    if (message !== null) {
      toast.success(`Deleted the model${message ? ` — ${message}` : ""}.`);
      onClosed();
    }
  };

  // ---- React Flow handlers ----

  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const first = picked[0];
    setSelection(first ? selectionOf(first.id) : null);
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag<CanvasNode>>(
    (_e, node, dragged) => {
      const start = fileRef.current;
      if (!start) return;
      let current: ModelFile = start;
      let refused = false;
      for (const moved of dragged.length > 0 ? dragged : [node]) {
        const picked = selectionOf(moved.id);
        if (!picked || picked.kind !== "element") continue;
        const target = dropTarget(current.model, current.layout, moved.position.x, moved.position.y);
        const next: ModelFile | null = target ? moveElement(current, picked.id, target) : null;
        if (next === null) refused = true;
        else current = next;
      }
      if (refused) {
        toast.error("A card goes in a free cell of a lane of its kind.");
      }
      if (current !== start) apply(current);
      else derive(current);
    },
    [apply, derive],
  );

  const isValidConnection = useCallback<IsValidConnection>((c) => {
    const from = c.source ? selectionOf(c.source) : null;
    const to = c.target ? selectionOf(c.target) : null;
    if (!from || !to || !fileRef.current) return false;
    return canDraw(fileRef.current, from.id, to.id);
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      const from = selectionOf(c.source);
      const to = selectionOf(c.target);
      if (!from || !to || !fileRef.current) return;
      apply(connect(fileRef.current, from.id, to.id), "Arrows go screen → command → event → read model.");
    },
    [apply],
  );

  const onEdgesDelete = useCallback(
    (gone: Edge[]) => {
      let current = fileRef.current;
      if (!current) return;
      for (const edge of gone) {
        const ends = edgeEnds(edge.id);
        if (ends) current = disconnect(current, ends.from, ends.to);
      }
      apply(current);
    },
    [apply],
  );

  const onNodesDelete = useCallback(
    async (gone: CanvasNode[]) => {
      const ids = gone.map((n) => selectionOf(n.id)).filter((s) => s?.kind === "element");
      if (ids.length === 0 || !fileRef.current) return;
      const ok = await confirm({
        title: ids.length === 1 ? "Delete card" : `Delete ${ids.length} cards`,
        body: "The cards and their arrows will be removed from the model.",
        confirmLabel: "Delete",
      });
      let current = fileRef.current;
      if (!ok) {
        derive(current);
        return;
      }
      for (const picked of ids) current = removeElement(current, picked!.id);
      setSelection(null);
      apply(current);
    },
    [apply, confirm, derive],
  );

  const exportUrl = modelExportUrl(fileName);
  const link = modelLink(fileName);
  const assignable = useMemo((): ProjectMember[] => {
    const assigned = file?.assigned;
    if (!assigned || members.some((m) => m.name === assigned)) return members;
    return [...members, { name: assigned }];
  }, [members, file?.assigned]);

  if (error) {
    return (
      <div className="em-pane">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!file) return <p className="hint">Loading the model…</p>;

  return (
    <div className="em-pane">
      <header className="editor-bar page-header">
        <Breadcrumbs
          items={[repoCrumb, { label: "Models" }]}
          tail={<span className="crumb current plain">{file.name || modelStem(fileName)}</span>}
        />
        <div className="editor-actions page-actions">
          <SaveIndicator saving={saving} savedAt={savedAt} dirty={dirty} />
          <Tooltip label={copied === link ? "Copied" : "Copy link"}>
            <button type="button" className="ibtn" aria-label="Copy link" onClick={() => onCopyLink(link)}>
              {copied === link ? <Check size={15} aria-hidden="true" /> : <Link size={15} aria-hidden="true" />}
            </button>
          </Tooltip>
          <Tooltip label="Export the model as Event Modeling JSON">
            <a className="ibtn" href={exportUrl} download aria-label="Export">
              <Download size={15} aria-hidden="true" />
            </a>
          </Tooltip>
          <span className="chip-anchor em-menu-anchor">
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
              label="Model actions"
              className="chip-menu chip-menu-end"
              containerSelector=".em-menu-anchor"
              items={[
                { id: "rename", label: "Rename", onSelect: () => void rename() },
                // A code gen session over the model (specs/agents/claude.spec.md):
                // the prompt carries the model's JSON and the specs its
                // slices link (src/server/session.ts).
                ...(onStartSession
                  ? [
                      {
                        id: "session",
                        label: "Start AI session over this model",
                        icon: <Play size={13} />,
                        onSelect: () => onStartSession(),
                      },
                    ]
                  : []),
                {
                  id: "arrange",
                  label: "Arrange all cards",
                  icon: <LayoutGrid size={13} />,
                  onSelect: () => apply(autoLayoutFile(file, true)),
                },
                {
                  id: "copy-json",
                  label: "Copy export JSON",
                  icon: <FileJson size={13} />,
                  onSelect: () =>
                    void navigator.clipboard
                      .writeText(JSON.stringify(file.model, null, 2))
                      .then(() => toast.success("Copied the model's JSON."))
                      .catch(() => toast.error("Could not copy to the clipboard.")),
                },
                { id: "delete", label: "Delete model", icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove() },
              ]}
            />
          </span>
        </div>
      </header>
      <div className="em-toolbar" role="toolbar" aria-label="Add to the model">
        {ELEMENT_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={`em-add em-${type.toLowerCase()}`}
            onClick={() => void addCard(type)}
          >
            <Plus size={13} aria-hidden="true" /> {typeLabel(type)}
          </button>
        ))}
        <span className="em-toolbar-gap" />
        <button type="button" className="em-add" onClick={() => void newSlice()}>
          <Plus size={13} aria-hidden="true" /> Slice
        </button>
        <button type="button" className="em-add" onClick={() => void newLane()}>
          <Plus size={13} aria-hidden="true" /> Events lane
        </button>
        <span className="em-toolbar-gap" />
        <Tooltip label="Lay every card out again from its arrows">
          <button type="button" className="em-add" onClick={() => apply(autoLayoutFile(file, true))}>
            <LayoutGrid size={13} aria-hidden="true" /> Arrange
          </button>
        </Tooltip>
        <span className="em-toolbar-end" />
        {assignments && (
          <span className="chip-anchor em-assignee-anchor">
            <button
              type="button"
              className={`chip${file.assigned ? "" : " muted"}`}
              aria-haspopup="menu"
              aria-expanded={assigneeOpen}
              aria-label={`Assigned: ${file.assigned ?? "nobody"}`}
              onClick={() => setAssigneeOpen((o) => !o)}
            >
              <UserRound size={14} aria-hidden="true" />
              {file.assigned ?? "Unassigned"}
            </button>
            <Menu
              open={assigneeOpen}
              onClose={() => setAssigneeOpen(false)}
              label="Assigned member"
              className="chip-menu chip-menu-end"
              containerSelector=".em-assignee-anchor"
              items={[
                {
                  id: "",
                  label: "Unassigned",
                  checked: !file.assigned,
                  onSelect: () => apply(setAssigned(file, null)),
                },
                ...assignable.map((m) => ({
                  id: m.name,
                  label: m.name,
                  checked: file.assigned === m.name,
                  onSelect: () => apply(setAssigned(file, m.name)),
                })),
              ]}
            />
          </span>
        )}
      </div>
      <div className="em-body">
        <div className="em-canvas">
          <SliceActionsContext.Provider value={sliceActions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={onSelectionChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onEdgesDelete={onEdgesDelete}
            onNodesDelete={(gone) => void onNodesDelete(gone as CanvasNode[])}
            deleteKeyCode={["Backspace", "Delete"]}
            colorMode={colorMode}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={1.5}
            snapToGrid={false}
            proOptions={{ hideAttribution: true }}
            elevateNodesOnSelect={false}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>
          </SliceActionsContext.Provider>
          {file.model.slices.length === 0 && (
            <div className="em-empty">
              <Workflow size={28} aria-hidden="true" />
              <p>An empty model. Add a slice, then the screen, command and event of it.</p>
            </div>
          )}
        </div>
        <aside className="em-inspector" aria-label="Inspector">
          <Inspector
            file={file}
            selection={selection}
            features={features}
            onChange={(next) => apply(next)}
            onDeselect={() => setSelection(null)}
            onOpenFeature={onOpenFeature}
            onGenerateFeature={(sliceId) => void generateFeature(sliceId)}
            prompt={prompt}
            confirm={confirm}
          />
        </aside>
      </div>
    </div>
  );
}

// ---- The sidebar: the models, listed ----

export interface ModelsSidebarProps {
  active: string | null;
  prompt: Prompt;
  confirm: Confirm;
  onNavigate: (fileName: string, opts?: { push?: boolean }) => void;
  onCopyLink: (path: string) => void;
  /** The open model was deleted from the list. */
  onClosed: (fileName: string) => void;
}

function groups(list: ModelListing[]): { dir: string; models: ModelListing[] }[] {
  const map = new Map<string, ModelListing[]>();
  for (const model of list) {
    const dir = model.fileName.split("/").slice(1, -1).join("/");
    const bucket = map.get(dir) ?? [];
    bucket.push(model);
    map.set(dir, bucket);
  }
  return [...map]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, models: list }));
}

export function ModelsSidebar({ active, prompt, confirm, onNavigate, onCopyLink, onClosed }: ModelsSidebarProps) {
  const store = useModels();
  const [menu, setMenu] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = async () => {
    const name = await prompt({
      title: "New model",
      hint: "Use folder/name to create inside a subfolder of models.",
      placeholder: "Shopping cart",
      confirmLabel: "Create model",
    });
    if (!name) return;
    const fileName = await models.create(name);
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
        : "") || picked.name.replace(/\.(eventmodel\.)?(model\.)?json$/i, "");
    const name = await prompt({
      title: "Import model",
      hint: "An Event Modeling JSON export — from another tool, or from here.",
      initial: guess,
      confirmLabel: "Import",
    });
    if (!name) return;
    const fileName = await models.create(name, parsed);
    if (fileName) onNavigate(fileName, { push: true });
  };

  const remove = async (model: ModelListing) => {
    const ok = await confirm({
      title: "Delete model",
      body: `“${model.name}” will be deleted, committed and pushed. This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const message = await models.remove(model.fileName);
    if (message === null) return;
    toast.success(`Deleted “${model.name}”${message ? ` — ${message}` : ""}.`);
    if (active === model.fileName) onClosed(model.fileName);
  };

  const row = (model: ModelListing, nested: boolean): ReactNode => (
    <div key={model.fileName} className={`page-row${nested ? " nested" : ""}`}>
      <a
        href={modelLink(model.fileName)}
        className={`page-entry${model.fileName === active ? " active" : ""}`}
        title={`${model.name} · ${model.slices} slice${model.slices === 1 ? "" : "s"}${model.assigned ? ` · ${model.assigned}` : ""}`}
        aria-current={model.fileName === active ? "page" : undefined}
        onClick={(e) => spaClick(e, () => onNavigate(model.fileName, { push: true }))}
      >
        {model.name}
      </a>
      <span className="tree-row-menu">
        <Tooltip label="More actions">
          <button
            type="button"
            className="tree-menu-btn"
            aria-label={`Menu for ${model.name}`}
            aria-haspopup="menu"
            aria-expanded={menu === model.fileName}
            onClick={() => setMenu((m) => (m === model.fileName ? null : model.fileName))}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <Menu
          open={menu === model.fileName}
          onClose={() => setMenu(null)}
          label={`Menu for ${model.name}`}
          className="tree-menu"
          containerSelector=".tree-row-menu"
          items={[
            { id: "copy", label: "Copy link", icon: <Link size={13} />, onSelect: () => onCopyLink(modelLink(model.fileName)) },
            {
              id: "export",
              label: "Export JSON",
              icon: <Download size={13} />,
              onSelect: () => window.open(modelExportUrl(model.fileName), "_blank"),
            },
            { id: "delete", label: "Delete", icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove(model) },
          ]}
        />
      </span>
    </div>
  );

  return (
    <div className="side-panel page-list" role="tabpanel" id="side-panel-models" aria-labelledby="side-tab-models">
      <div className="sidebar-actions">
        <button onClick={() => void create()}>+ New model</button>
        <Tooltip label="Import an Event Modeling JSON file">
          <button className="em-import" aria-label="Import" onClick={() => fileInput.current?.click()}>
            <Upload size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void imported(e)} />
      </div>
      <div className="page-rows">
        {store.error && <p className="error">{store.error}</p>}
        {groups(store.models).map(({ dir, models: list }) => (
          <div key={dir || "."}>
            {dir && <div className="page-group">{dir}</div>}
            {list.map((model) => row(model, dir !== ""))}
          </div>
        ))}
        {store.loaded && store.models.length === 0 && <p className="empty">No models yet</p>}
      </div>
    </div>
  );
}
