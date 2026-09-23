// The canvas's cards, bands and rows (roadmap/support-event-modeling.md):
// React Flow node components for an element, a slice and a lane. A card
// wears its type's colour — the cheat sheet's: screens white, commands
// blue, events orange, read models green, automations violet — and carries
// the handles an arrow starts and ends on, shown while the pointer is over
// it. Bands and rows are backgrounds: not draggable, selectable for the
// inspector.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, useContext } from "react";
import { SliceActionsContext } from "./context";
import { typeLabel } from "./mutations";
import type { ElementNode, LaneNode, SliceNode } from "./flow";

const SLICE_TYPE_LABEL = {
  STATE_CHANGE: "State change",
  STATE_VIEW: "State view",
  AUTOMATION: "Automation",
} as const;

function ElementNodeView({ data, selected }: NodeProps<ElementNode>) {
  const { element } = data;
  const fields = element.fields.map((f) => f.name).filter(Boolean);
  const external = element.context === "EXTERNAL";
  return (
    <div
      className={`em-card em-${element.type.toLowerCase()}${selected ? " selected" : ""}${external ? " external" : ""}`}
      title={element.description || element.title}
    >
      <Handle type="target" position={Position.Top} id="t-top" style={{ left: "35%" }} />
      <Handle type="source" position={Position.Top} id="s-top" style={{ left: "65%" }} />
      <Handle type="target" position={Position.Left} id="t-left" />
      <Handle type="source" position={Position.Right} id="s-right" />
      <Handle type="target" position={Position.Bottom} id="t-bottom" style={{ left: "35%" }} />
      <Handle type="source" position={Position.Bottom} id="s-bottom" style={{ left: "65%" }} />
      <div className="em-card-kind">
        {typeLabel(element.type)}
        {external && <span className="em-card-tag">external</span>}
        {element.type === "EVENT" && element.aggregate && (
          <span className="em-card-tag">{element.aggregate}</span>
        )}
      </div>
      <div className="em-card-title">{element.title || "Untitled"}</div>
      {fields.length > 0 && (
        <div className="em-card-fields">
          {fields.slice(0, 3).join(", ")}
          {fields.length > 3 ? ` +${fields.length - 3}` : ""}
        </div>
      )}
    </div>
  );
}

function SliceNodeView({ data, selected }: NodeProps<SliceNode>) {
  const { slice, index, feature } = data;
  const { openFeature } = useContext(SliceActionsContext);
  return (
    <div className={`em-slice${selected ? " selected" : ""}`}>
      <div className="em-slice-head">
        <span className="em-slice-index">{index + 1}</span>
        <span className="em-slice-title">{slice.title || "Untitled slice"}</span>
        <span className="em-slice-kind">{SLICE_TYPE_LABEL[slice.sliceType]}</span>
        {/* The bridge to the specs: the band's "spec" opens the feature file
            holding the slice's scenarios. `nodrag` keeps React Flow from
            taking the press as the start of a drag. */}
        {feature && (
          <button
            type="button"
            className="em-slice-link nodrag"
            title={`Open ${feature}`}
            aria-label={`Open the feature ${feature}`}
            onClick={(e) => {
              e.stopPropagation();
              openFeature(feature);
            }}
          >
            spec
          </button>
        )}
        {slice.specifications.length > 0 && (
          <span className="em-slice-specs" title={`${slice.specifications.length} Given/When/Then`}>
            {slice.specifications.length} GWT
          </span>
        )}
      </div>
    </div>
  );
}

function LaneNodeView({ data, selected }: NodeProps<LaneNode>) {
  const { lane } = data;
  return (
    <div className={`em-lane em-lane-${lane.kind.toLowerCase()}${selected ? " selected" : ""}`}>
      <div className="em-lane-title">
        {lane.title}
        {lane.aggregate && <span className="em-card-tag">{lane.aggregate}</span>}
      </div>
    </div>
  );
}

export const nodeTypes = {
  element: memo(ElementNodeView),
  slice: memo(SliceNodeView),
  lane: memo(LaneNodeView),
};
