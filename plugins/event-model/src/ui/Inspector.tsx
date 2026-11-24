// The inspector beside the canvas (roadmap/support-event-modeling.md): what
// the selected card, band or row is, editable. A card's title, description
// and typed fields; a slice's title, pattern, status, band width, the
// feature file that holds its scenarios, and its Given / When / Then
// examples; a lane's title and stream. Every edit is a mutation of the file
// (mutations.ts) handed back up, so the canvas redraws and autosave runs.

import { ArrowLeft, ArrowRight, ExternalLink, FilePlus2, Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  FIELD_TYPES,
  SLICE_STATUSES,
  SLICE_TYPES,
  allElements,
  findElement,
  type Element,
  type ElementType,
  type Field,
  type ModelFile,
  type Slice,
  type SpecStepType,
  type Specification,
  type SpecificationStep,
} from "../model/types";
import { featurePath, type ConfirmOptions, type FeatureListing, type PromptOptions } from "@specdriven/client";
import type { Selection } from "./flow";
import {
  addSpecification,
  arrows,
  moveSlice,
  newField,
  removeElement,
  removeLane,
  removeSlice,
  removeSpecification,
  setSliceLink,
  setSliceWidth,
  typeLabel,
  updateElement,
  updateLane,
  updateSlice,
  updateSpecification,
} from "./mutations";

type Prompt = (opts: PromptOptions) => Promise<string | null>;
type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

export interface InspectorProps {
  file: ModelFile;
  selection: Selection | null;
  features: FeatureListing[];
  onChange: (file: ModelFile) => void;
  /** After a removal: nothing is selected any more. */
  onDeselect: () => void;
  onOpenFeature: (fileName: string) => void;
  /** Scaffold the slice's feature file from its Given / When / Then (ModelsPane). */
  onGenerateFeature: (sliceId: string) => void;
  prompt: Prompt;
  confirm: Confirm;
}

const SLICE_TYPE_LABEL = {
  STATE_CHANGE: "State change",
  STATE_VIEW: "State view",
  AUTOMATION: "Automation",
} as const;

const STEP_TYPES: { type: SpecStepType; label: string; element: ElementType | null }[] = [
  { type: "SPEC_EVENT", label: "Event", element: "EVENT" },
  { type: "SPEC_COMMAND", label: "Command", element: "COMMAND" },
  { type: "SPEC_READMODEL", label: "Read model", element: "READMODEL" },
  { type: "SPEC_ERROR", label: "Error", element: null },
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="em-row">
      <span className="em-row-label">{label}</span>
      {children}
    </label>
  );
}

export function Inspector(props: InspectorProps) {
  const { file, selection } = props;
  if (!selection) {
    return (
      <div className="em-inspector-empty">
        <p>Select a card, a slice band or a lane to edit it.</p>
        <p className="hint">
          Drag a card between cells to move it; drag from a card's handle to another card to draw an
          arrow. Backspace removes what is selected.
        </p>
      </div>
    );
  }
  if (selection.kind === "element") {
    const found = findElement(file.model, selection.id);
    return found ? <ElementPanel {...props} element={found.element} slice={found.slice} /> : null;
  }
  if (selection.kind === "slice") {
    const slice = file.model.slices.find((s) => s.id === selection.id);
    return slice ? <SlicePanel {...props} slice={slice} /> : null;
  }
  const lane = file.layout.lanes.find((l) => l.id === selection.id);
  return lane ? <LanePanel {...props} lane={lane} /> : null;
}

function ElementPanel({
  file,
  element,
  slice,
  onChange,
  onDeselect,
  confirm,
}: InspectorProps & { element: Element; slice: Slice }) {
  const patch = (p: Parameters<typeof updateElement>[2]) => onChange(updateElement(file, element.id, p));
  const setFields = (fields: Field[]) => patch({ fields });
  const links = arrows(file).filter((a) => a.from === element.id || a.to === element.id);
  const titleOf = (id: string) => findElement(file.model, id)?.element.title ?? id;
  return (
    <div className="em-panel">
      <div className={`em-panel-head em-${element.type.toLowerCase()}`}>
        <span className="em-panel-kind">{typeLabel(element.type)}</span>
        <span className="em-panel-sub">in slice “{slice.title || "Untitled"}”</span>
      </div>
      <Row label="Title">
        <input
          value={element.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder={typeLabel(element.type)}
          autoFocus
        />
      </Row>
      <Row label="Description">
        <textarea
          rows={3}
          value={element.description ?? ""}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="What it means, when it happens…"
        />
      </Row>
      {element.type === "EVENT" && (
        <Row label="Stream / aggregate">
          <input
            value={element.aggregate ?? ""}
            onChange={(e) => patch({ aggregate: e.target.value })}
            placeholder="Cart"
          />
        </Row>
      )}
      <Row label="Context">
        <select
          value={element.context ?? "INTERNAL"}
          onChange={(e) => patch({ context: e.target.value === "EXTERNAL" ? "EXTERNAL" : undefined, clearContext: e.target.value !== "EXTERNAL" })}
        >
          <option value="INTERNAL">This system</option>
          <option value="EXTERNAL">External system</option>
        </select>
      </Row>
      <section className="em-section">
        <div className="em-section-head">
          <span>Fields</span>
          <button type="button" className="ibtn" aria-label="Add field" onClick={() => setFields([...element.fields, newField()])}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {element.fields.length === 0 && <p className="hint">No fields yet.</p>}
        {element.fields.map((field, i) => (
          <div key={i} className="em-field">
            <input
              value={field.name}
              placeholder="name"
              aria-label="Field name"
              onChange={(e) => setFields(element.fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
            />
            <select
              value={field.type}
              aria-label="Field type"
              onChange={(e) =>
                setFields(element.fields.map((f, j) => (j === i ? { ...f, type: e.target.value as Field["type"] } : f)))
              }
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="em-check" title="Optional">
              <input
                type="checkbox"
                checked={field.optional ?? false}
                onChange={(e) =>
                  setFields(element.fields.map((f, j) => (j === i ? { ...f, optional: e.target.checked || undefined } : f)))
                }
              />
              opt
            </label>
            <label className="em-check" title="Personal data">
              <input
                type="checkbox"
                checked={field.pii ?? false}
                onChange={(e) =>
                  setFields(element.fields.map((f, j) => (j === i ? { ...f, pii: e.target.checked || undefined } : f)))
                }
              />
              pii
            </label>
            <button
              type="button"
              className="ibtn"
              aria-label="Remove field"
              onClick={() => setFields(element.fields.filter((_, j) => j !== i))}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </section>
      <section className="em-section">
        <div className="em-section-head">
          <span>Arrows</span>
        </div>
        {links.length === 0 && <p className="hint">Not connected yet — drag from a handle to another card.</p>}
        <ul className="em-list">
          {links.map((a) => (
            <li key={`${a.from}->${a.to}`}>
              {a.from === element.id ? (
                <>
                  <ArrowRight size={12} aria-hidden="true" /> {titleOf(a.to)}
                </>
              ) : (
                <>
                  <ArrowLeft size={12} aria-hidden="true" /> {titleOf(a.from)}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      <div className="em-panel-foot">
        <button
          type="button"
          className="danger"
          onClick={async () => {
            if (
              await confirm({
                title: `Delete ${typeLabel(element.type).toLowerCase()}`,
                body: `“${element.title}” and its arrows will be removed from the model.`,
                confirmLabel: "Delete",
              })
            ) {
              onChange(removeElement(file, element.id));
              onDeselect();
            }
          }}
        >
          <Trash2 size={13} aria-hidden="true" /> Delete card
        </button>
      </div>
    </div>
  );
}

function SlicePanel({
  file,
  slice,
  features,
  onChange,
  onDeselect,
  onOpenFeature,
  onGenerateFeature,
  prompt,
  confirm,
}: InspectorProps & { slice: Slice }) {
  const index = file.model.slices.findIndex((s) => s.id === slice.id);
  const width = file.layout.slices[slice.id]?.width ?? 1;
  const feature = file.links[slice.id]?.feature ?? "";
  const known = features.some((f) => f.fileName === feature);
  return (
    <div className="em-panel">
      <div className="em-panel-head">
        <span className="em-panel-kind">Slice {index + 1}</span>
        <span className="em-panel-sub">{SLICE_TYPE_LABEL[slice.sliceType]}</span>
      </div>
      <Row label="Title">
        <input
          value={slice.title}
          onChange={(e) => onChange(updateSlice(file, slice.id, { title: e.target.value }))}
          placeholder="Add item to cart"
          autoFocus
        />
      </Row>
      <Row label="Pattern">
        <select
          value={slice.sliceType}
          onChange={(e) => onChange(updateSlice(file, slice.id, { sliceType: e.target.value as Slice["sliceType"] }))}
        >
          {SLICE_TYPES.map((t) => (
            <option key={t} value={t}>
              {SLICE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Status">
        <select
          value={slice.status ?? ""}
          onChange={(e) => onChange(updateSlice(file, slice.id, { status: e.target.value as Slice["status"] }))}
        >
          <option value="">—</option>
          {SLICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "InProgress" ? "In progress" : s}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Band width">
        <span className="em-stepper">
          <button type="button" className="ibtn" aria-label="Narrower" onClick={() => onChange(setSliceWidth(file, slice.id, width - 1))}>
            −
          </button>
          <span>{width} col{width === 1 ? "" : "s"}</span>
          <button type="button" className="ibtn" aria-label="Wider" onClick={() => onChange(setSliceWidth(file, slice.id, width + 1))}>
            +
          </button>
        </span>
      </Row>
      <Row label="Order">
        <span className="em-stepper">
          <button
            type="button"
            className="ibtn"
            aria-label="Move left"
            disabled={index <= 0}
            onClick={() => onChange(moveSlice(file, slice.id, index - 1))}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <span>
            {index + 1} of {file.model.slices.length}
          </span>
          <button
            type="button"
            className="ibtn"
            aria-label="Move right"
            disabled={index >= file.model.slices.length - 1}
            onClick={() => onChange(moveSlice(file, slice.id, index + 1))}
          >
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </span>
      </Row>
      {/* The bridge to the specs: the feature file whose scenarios are this
          slice's Given / When / Then in BDD form. */}
      <Row label="Feature file">
        <span className="em-inline">
          <select value={feature} onChange={(e) => onChange(setSliceLink(file, slice.id, e.target.value || null))}>
            <option value="">— none —</option>
            {!known && feature && <option value={feature}>{feature}</option>}
            {features.map((f) => (
              <option key={f.fileName} value={f.fileName}>
                {f.name} ({f.fileName})
              </option>
            ))}
          </select>
          {feature && (
            <a
              className="ibtn"
              href={featurePath(feature)}
              aria-label="Open the feature"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onOpenFeature(feature);
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </span>
      </Row>
      {/* No feature yet: scaffold one from the slice — a scenario per
          Given / When / Then below (src/model/feature.ts). */}
      {!feature && (
        <div className="em-row">
          <button type="button" className="secondary em-generate" onClick={() => onGenerateFeature(slice.id)}>
            <FilePlus2 size={13} aria-hidden="true" /> Generate feature file
            {slice.specifications.length > 0 && (
              <span className="em-generate-count">
                {slice.specifications.length} scenario{slice.specifications.length === 1 ? "" : "s"}
              </span>
            )}
          </button>
        </div>
      )}
      <section className="em-section">
        <div className="em-section-head">
          <span>Given / When / Then</span>
          <button
            type="button"
            className="ibtn"
            aria-label="Add specification"
            onClick={async () => {
              const title = await prompt({
                title: "New specification",
                placeholder: "adds the item to the cart",
                confirmLabel: "Add",
              });
              if (title) onChange(addSpecification(file, slice.id, title).file);
            }}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        {slice.specifications.length === 0 && (
          <p className="hint">No examples yet. Each is a Given / When / Then over the model's cards.</p>
        )}
        {slice.specifications.map((spec) => (
          <SpecificationEditor
            key={spec.id}
            file={file}
            spec={spec}
            onChange={(next) => onChange(updateSpecification(file, slice.id, next))}
            onRemove={() => onChange(removeSpecification(file, slice.id, spec.id))}
          />
        ))}
      </section>
      <div className="em-panel-foot">
        <button
          type="button"
          className="danger"
          onClick={async () => {
            if (
              await confirm({
                title: "Delete slice",
                body: `“${slice.title}” and every card in it will be removed from the model.`,
                confirmLabel: "Delete",
              })
            ) {
              onChange(removeSlice(file, slice.id));
              onDeselect();
            }
          }}
        >
          <Trash2 size={13} aria-hidden="true" /> Delete slice
        </button>
      </div>
    </div>
  );
}

function SpecificationEditor({
  file,
  spec,
  onChange,
  onRemove,
}: {
  file: ModelFile;
  spec: Specification;
  onChange: (spec: Specification) => void;
  onRemove: () => void;
}) {
  const elements = allElements(file.model).map((e) => e.element);
  const setSteps = (key: "given" | "when" | "then", steps: SpecificationStep[]) =>
    onChange({ ...spec, [key]: steps });
  const stepList = (key: "given" | "when" | "then", allowed: SpecStepType[]) => (
    <div className="em-steps">
      <div className="em-steps-head">
        <span>{key[0]!.toUpperCase() + key.slice(1)}</span>
        <button
          type="button"
          className="ibtn"
          aria-label={`Add ${key} step`}
          onClick={() =>
            setSteps(key, [
              ...spec[key],
              { id: `${spec.id}-${key}-${Date.now().toString(36)}`, title: "", type: allowed[0]! },
            ])
          }
        >
          <Plus size={12} aria-hidden="true" />
        </button>
      </div>
      {spec[key].map((step, i) => {
        const kind = STEP_TYPES.find((t) => t.type === step.type)!;
        const candidates = kind.element ? elements.filter((e) => e.type === kind.element) : [];
        return (
          <div key={step.id} className="em-step">
            <select
              value={step.type}
              aria-label="Step kind"
              onChange={(e) =>
                setSteps(
                  key,
                  spec[key].map((s, j) =>
                    j === i ? { ...s, type: e.target.value as SpecStepType, linkedId: undefined } : s,
                  ),
                )
              }
            >
              {STEP_TYPES.filter((t) => allowed.includes(t.type)).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
            {kind.element ? (
              <select
                value={step.linkedId ?? ""}
                aria-label="Card"
                onChange={(e) => {
                  const picked = elements.find((el) => el.id === e.target.value);
                  setSteps(
                    key,
                    spec[key].map((s, j) =>
                      j === i
                        ? { ...s, linkedId: picked?.id, title: picked ? picked.title : s.title }
                        : s,
                    ),
                  );
                }}
              >
                <option value="">— pick a card —</option>
                {candidates.map((el) => (
                  <option key={el.id} value={el.id}>
                    {el.title}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={step.title}
                placeholder="Error"
                aria-label="Error"
                onChange={(e) => setSteps(key, spec[key].map((s, j) => (j === i ? { ...s, title: e.target.value } : s)))}
              />
            )}
            <button
              type="button"
              className="ibtn"
              aria-label="Remove step"
              onClick={() => setSteps(key, spec[key].filter((_, j) => j !== i))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
  return (
    <div className="em-spec">
      <div className="em-spec-head">
        <input
          value={spec.title}
          aria-label="Specification title"
          onChange={(e) => onChange({ ...spec, title: e.target.value })}
        />
        <button type="button" className="ibtn" aria-label="Remove specification" onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      {stepList("given", ["SPEC_EVENT", "SPEC_READMODEL"])}
      {stepList("when", ["SPEC_COMMAND", "SPEC_EVENT"])}
      {stepList("then", ["SPEC_EVENT", "SPEC_READMODEL", "SPEC_ERROR"])}
    </div>
  );
}

function LanePanel({ file, lane, onChange, onDeselect, confirm }: InspectorProps & { lane: ModelFile["layout"]["lanes"][number] }) {
  const last = !file.layout.lanes.some((l) => l.kind === lane.kind && l.id !== lane.id);
  return (
    <div className="em-panel">
      <div className="em-panel-head">
        <span className="em-panel-kind">Lane</span>
        <span className="em-panel-sub">
          {lane.kind === "EVENTS" ? "Events" : lane.kind === "COMMAND_READMODEL" ? "Commands and read models" : "Screens and automations"}
        </span>
      </div>
      <Row label="Title">
        <input value={lane.title} onChange={(e) => onChange(updateLane(file, lane.id, { title: e.target.value }))} autoFocus />
      </Row>
      {lane.kind === "EVENTS" && (
        <Row label="Stream / aggregate">
          <input
            value={lane.aggregate ?? ""}
            placeholder="Cart"
            onChange={(e) => onChange(updateLane(file, lane.id, { aggregate: e.target.value }))}
          />
        </Row>
      )}
      <div className="em-panel-foot">
        <button
          type="button"
          className="danger"
          disabled={last}
          title={last ? "The last lane of its kind stays" : undefined}
          onClick={async () => {
            if (
              await confirm({
                title: "Delete lane",
                body: `Cards in “${lane.title}” move to the other lane of its kind.`,
                confirmLabel: "Delete",
              })
            ) {
              const next = removeLane(file, lane.id);
              if (next) {
                onChange(next);
                onDeselect();
              }
            }
          }}
        >
          <Trash2 size={13} aria-hidden="true" /> Delete lane
        </button>
      </div>
    </div>
  );
}
