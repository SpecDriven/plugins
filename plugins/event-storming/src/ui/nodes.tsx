// What the wall draws: a sticky note of its kind's colour — a hotspot
// turned on its corner, as the workshop sticks it, and a pivotal event
// with the boundary line taped through it — and an area, a labelled frame
// that is dragged by its label and resized by its corners. Writing on
// either happens in place; the wall hands the nodes what to do through a
// context, as React Flow renders them itself.

import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MIN_AREA, STICKY } from "../storm/types";
import type { AreaNode, StickyNode } from "./flow";

export interface WallActions {
  /** The sticky or area being written on, if any. */
  editing: string | null;
  startEdit: (id: string) => void;
  /** The text written; the wall ends the edit. */
  commitText: (id: string, text: string) => void;
  cancelEdit: () => void;
  resizeArea: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
}

export const WallActionsContext = createContext<WallActions>({
  editing: null,
  startEdit: () => {},
  commitText: () => {},
  cancelEdit: () => {},
  resizeArea: () => {},
});

/** Smaller type for more words, so a sticky holds what was written on it. */
export function fontSize(text: string, kind: StickyNode["data"]["sticky"]["kind"]): number {
  const n = text.length;
  const base = kind === "actor" ? 12 : 15;
  if (n <= 24) return base;
  if (n <= 48) return base - 2;
  if (n <= 90) return base - 3;
  return base - 4;
}

/** A textarea that commits on Enter or blur, and cancels on Escape. */
function Writer({
  initial,
  placeholder,
  multiline,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  multiline: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(text.trim());
    else onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    } else if (e.key === "Enter" && !(multiline && e.shiftKey)) {
      e.preventDefault();
      finish(true);
    }
  };
  return (
    <textarea
      ref={ref}
      className="storm-writer nodrag nopan nowheel"
      value={text}
      placeholder={placeholder}
      rows={multiline ? 4 : 1}
      aria-label="Text"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
    />
  );
}

export function StickyView({ data, selected }: NodeProps<StickyNode>) {
  const { sticky } = data;
  const info = STICKY[sticky.kind];
  const actions = useContext(WallActionsContext);
  const editing = actions.editing === sticky.id;
  return (
    <div
      className={`storm-sticky storm-${sticky.kind}${sticky.pivotal ? " pivotal" : ""}${selected ? " selected" : ""}`}
      style={{ ["--paper" as string]: info.color, ["--ink" as string]: info.ink }}
      title={`${info.label}${sticky.pivotal ? " (pivotal)" : ""}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        actions.startEdit(sticky.id);
      }}
    >
      <Handle type="target" position={Position.Left} className="storm-handle" />
      {sticky.kind === "hotspot" && <span className="storm-diamond" aria-hidden="true" />}
      <span className="storm-kind" aria-hidden="true">
        {sticky.pivotal ? "Pivotal event" : info.label}
      </span>
      {editing ? (
        <Writer
          initial={sticky.text}
          placeholder={info.example}
          multiline
          onCommit={(text) => actions.commitText(sticky.id, text)}
          onCancel={actions.cancelEdit}
        />
      ) : (
        <span className={`storm-text${sticky.text ? "" : " blank"}`} style={{ fontSize: fontSize(sticky.text, sticky.kind) }}>
          {sticky.text || info.example}
        </span>
      )}
      <Handle type="source" position={Position.Right} className="storm-handle" />
    </div>
  );
}

export function AreaView({ id, data, selected }: NodeProps<AreaNode>) {
  const { area } = data;
  const actions = useContext(WallActionsContext);
  const editing = actions.editing === area.id;
  return (
    <div className={`storm-area${selected ? " selected" : ""}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_AREA.width}
        minHeight={MIN_AREA.height}
        lineClassName="storm-resize-line"
        handleClassName="storm-resize-handle"
        onResizeEnd={(_e, box) => actions.resizeArea(id, box)}
      />
      {editing ? (
        <div className="storm-area-label editing">
          <Writer
            initial={area.label}
            placeholder="Bounded context"
            multiline={false}
            onCommit={(text) => actions.commitText(area.id, text)}
            onCancel={actions.cancelEdit}
          />
        </div>
      ) : (
        <div
          className={`storm-area-label${area.label ? "" : " blank"}`}
          title="Drag to move · double-click to rename"
          onDoubleClick={(e) => {
            e.stopPropagation();
            actions.startEdit(area.id);
          }}
        >
          {area.label || "Unnamed area"}
        </div>
      )}
    </div>
  );
}

export const nodeTypes = { sticky: StickyView, area: AreaView };
