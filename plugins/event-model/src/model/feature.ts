// The bridge from a model to the specs (roadmap/support-event-modeling.md):
// a slice's Given / When / Then examples are what a feature's scenarios
// are, so a slice can scaffold its feature file. One scenario per
// specification, the steps as the markdown bullets a scenario body is
// written in, and the examples the steps carry as tables — the
// Gherkin-style table the scenario editor's table widget then edits
// (the app's src/frontend/mdtable.ts). The description points back at the model,
// so someone reading the file — or an agent implementing it — knows where
// the map is; the structured link lives in the model's `links`.

import type { Element, ModelFile, Slice, SpecificationStep } from "./types";
import { findElement } from "./types";

export interface GeneratedFeature {
  /** The feature's display name — the `# ` heading. */
  name: string;
  /** The whole `.feature.md` text. */
  text: string;
}

/**
 * The feature file a slice scaffolds, or null when the slice is not in the
 * model. `name` overrides the heading (the slice's title by default) — the
 * name the file is created under, so heading and file agree.
 */
export function featureFromSlice(
  file: ModelFile,
  modelFileName: string,
  sliceId: string,
  name?: string,
): GeneratedFeature | null {
  const index = file.model.slices.findIndex((s) => s.id === sliceId);
  const slice = file.model.slices[index];
  if (!slice) return null;
  const heading = (name ?? "").trim() || slice.title.trim() || `Slice ${index + 1}`;
  const modelName = file.name.trim() || modelFileName;
  const parts = [
    `# ${heading}`,
    `Scenarios of the slice “${slice.title.trim() || heading}” in the Event Model “${modelName}” (${modelFileName}).`,
  ];
  const taken = new Set<string>();
  slice.specifications.forEach((spec, i) => {
    const scenarioName = uniqueName(spec.title.trim() || `Example ${i + 1}`, taken);
    const chunks = [`## ${scenarioName} @v1 [proposed]`];
    const body = scenarioBody(file, spec);
    if (body) chunks.push(body);
    parts.push(chunks.join("\n\n"));
  });
  return { name: heading, text: parts.join("\n\n") + "\n" };
}

/** A scenario name no earlier scenario of the file took: "x", "x (2)", … */
function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (${n})`;
  taken.add(candidate);
  return candidate;
}

/**
 * The bullets and tables of one specification. Steps without a title —
 * a row added and never filled — are left out; a specification with none
 * is a heading alone, for the author to fill in.
 */
function scenarioBody(file: ModelFile, spec: Slice["specifications"][number]): string {
  const bullets: string[] = [];
  const tables: string[] = [];
  const keywords = { given: "Given", when: "When", then: "Then" } as const;
  for (const key of ["given", "when", "then"] as const) {
    let first = true;
    for (const step of spec[key]) {
      const title = stepTitle(file, step);
      if (!title) continue;
      bullets.push(`- **${first ? keywords[key] : "And"}** ${phrase(step, title)}`);
      first = false;
      const table = exampleTable(file, step);
      if (table) tables.push(`Examples for ${title}:\n\n${table}`);
    }
  }
  return [bullets.join("\n"), ...tables].filter(Boolean).join("\n\n");
}

/** A step's title, or the card it stands for, or nothing. */
function stepTitle(file: ModelFile, step: SpecificationStep): string {
  const own = step.title.trim();
  if (own) return own;
  return linkedElement(file, step)?.title.trim() ?? "";
}

function linkedElement(file: ModelFile, step: SpecificationStep): Element | null {
  return step.linkedId ? (findElement(file.model, step.linkedId)?.element ?? null) : null;
}

/** How a step reads after its keyword. */
function phrase(step: SpecificationStep, title: string): string {
  switch (step.type) {
    case "SPEC_ERROR":
      return `the error “${title}”`;
    case "SPEC_READMODEL":
      return step.expectEmptyList ? `${title} is empty` : title;
    default:
      return title;
  }
}

/**
 * The step's examples as a table: its own rows, else one row of the
 * example values its fields (or its card's fields) carry. No examples, no
 * table.
 */
function exampleTable(file: ModelFile, step: SpecificationStep): string | null {
  const rows: Record<string, unknown>[] = [];
  if (step.examples && step.examples.length > 0) {
    rows.push(...step.examples);
  } else {
    const fields = step.fields?.length ? step.fields : (linkedElement(file, step)?.fields ?? []);
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.example !== undefined && field.example !== "") row[field.name] = field.example;
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  if (columns.length === 0) return null;
  return markdownTable(
    columns,
    rows.map((row) => columns.map((c) => cell(row[c]))),
  );
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A markdown table as the scenario table widget writes one (mdtable.ts). */
function markdownTable(columns: string[], rows: string[][]): string {
  const esc = (text: string) => text.replaceAll("|", "\\|");
  const widths = columns.map((col, c) =>
    Math.max(3, esc(col).length, ...rows.map((r) => esc(r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((text, c) => esc(text).padEnd(widths[c]!)).join(" | ")} |`;
  return [line(columns), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...rows.map(line)].join(
    "\n",
  );
}
