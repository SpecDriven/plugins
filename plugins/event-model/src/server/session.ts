// What a code gen session bundles from the Event Models (the app's
// src/server/agent.ts buildSessionPrompt, through the `sessions` service):
// the map the specs belong to, so the agent sees the slices, their cards
// and arrows alongside the scenarios — the model open on the Models tab
// when the session started, or one whose slice links a selected spec.

import type { SessionSection } from "@specdriven/host";
import { serializeExport } from "../model/serialize";
import { listModels, readModel, type ModelView } from "./models";

/** An Event Model as the session prompt takes it. */
export interface ModelInput {
  /** Repo-relative file, e.g. `models/cart.model.json`. */
  fileName: string;
  name: string;
  /** The slices in model order, each with the spec holding its scenarios. */
  slices: { title: string; feature?: string }[];
  /** The schema's half of the model — Event Modeling JSON — as text. */
  json: string;
}

/**
 * The models a code gen session bundles: the ones asked for by file name,
 * plus every model whose slice links one of the session's specs. A model
 * asked for by name that is not there is an error; the specs its slices
 * link come back too, for the session to take on when it ran from the
 * model alone.
 */
export async function sessionModels(
  dataDir: string,
  wanted: string[],
  specFiles: string[],
): Promise<{ models: ModelInput[]; features: string[] }> {
  const views = new Map<string, ModelView>();
  for (const fileName of wanted) {
    if (views.has(fileName)) continue;
    const view = await readModel(dataDir, fileName);
    if (view === null) throw new Error(`model not found: ${fileName}`);
    views.set(fileName, view);
  }
  if (specFiles.length > 0) {
    for (const listed of await listModels(dataDir)) {
      if (views.has(listed.fileName)) continue;
      if (!listed.links.some((l) => specFiles.includes(l.feature))) continue;
      const view = await readModel(dataDir, listed.fileName);
      if (view !== null) views.set(listed.fileName, view);
    }
  }
  const models: ModelInput[] = [];
  const features: string[] = [];
  for (const view of views.values()) {
    models.push(modelInput(view));
    for (const link of view.links) {
      if (!features.includes(link.feature) && !specFiles.includes(link.feature)) {
        features.push(link.feature);
      }
    }
  }
  return { models, features };
}

/** A model as the session prompt takes it. */
export function modelInput(view: ModelView): ModelInput {
  return {
    fileName: view.fileName,
    name: view.name,
    slices: view.file.model.slices.map((slice) => {
      const feature = view.file.links[slice.id]?.feature;
      return { title: slice.title || "Untitled slice", ...(feature ? { feature } : {}) };
    }),
    json: serializeExport(view.file.model),
  };
}

/**
 * How a model reads in the prompt: what it is, which spec holds each
 * slice's scenarios, then the JSON. The map comes first so an agent can
 * place every spec in it before reading the cards.
 */
export function modelSection(model: ModelInput, withSpecs: boolean): SessionSection {
  const lines = [
    `The Event Model "${model.name}"${withSpecs ? " the specifications above belong to" : ""}: ` +
      "a timeline of screens, commands, events and read models in swimlanes, cut into vertical " +
      "slices (eventmodeling.org), as Event Modeling JSON. Its slices, and the specification that " +
      "holds each one's scenarios:",
  ];
  for (const slice of model.slices) {
    lines.push(`- ${slice.title}${slice.feature ? ` → ${slice.feature}` : " — no specification yet"}`);
  }
  if (model.slices.length === 0) lines.push("- (no slices yet)");
  lines.push("", "```json", model.json.trimEnd(), "```");
  return { heading: `Event Model: ${model.fileName}`, noun: { one: "Event Model", many: "Event Models" }, lines };
}
