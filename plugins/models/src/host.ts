// The Event Models plugin's host half (roadmap/support-event-modeling.md in
// specs-specdriven): the JSON files in the data repo's `models` folder, each
// drawn on the Models tab's canvas, on routes that exist only while the
// plugin is mounted — list, create, read, save, delete, plus an export of
// the schema's half for other tools and a slice's feature scaffold. And
// what the app asks of a plugin with files of its own: the folder, made as
// the plugin goes on and kept in step with its documents on every sync
// tick; the `models` search scope the tab's palette searches; the model a
// code gen session bundles; the folder reserved from the specs-folder
// migration, which tells the plugin where the features it moved went.

import { json, type Context, type DataAccess, type Handler, type Params, type Plugin } from "@specdriven/host";
import { serializeExport } from "./model/serialize";
import { MODELS_FOLDER } from "./route";
import {
  createModel,
  deleteModel,
  ensureModelsFolder,
  exportModel,
  generateSliceFeature,
  importModelDrift,
  listModels,
  readModel,
  saveModel,
} from "./server/models";
import { relinkModels } from "./server/relink";
import { modelSearch } from "./server/search";
import { modelSection, sessionModels } from "./server/session";

type DirHandler = (dir: string, req: Request, params: Params) => Response | Promise<Response>;

/** Against the data dir, with the module's errors as 400 answers — or, for
    a route that says so, 404 when the message says the thing is not there. */
const guarded =
  (data: DataAccess) =>
  (handler: DirHandler, { notFound = false }: { notFound?: boolean } = {}): Handler =>
    data.withDir(async (dir, req, params) => {
      try {
        return await handler(dir, req, params);
      } catch (e) {
        const message = (e as Error).message;
        return json({ error: message }, notFound && /not found/i.test(message) ? 404 : 400);
      }
    });

const plugin: Plugin<Context> = {
  name: "models",
  inject: ["routes", "data", "sync", "search", "sessions"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const data = ctx.need("data");
    const sync = ctx.need("sync");
    const on = guarded(data);
    const add = (method: string, pattern: string, handler: DirHandler, opts?: { notFound?: boolean }) =>
      ctx.effect(() => routes.add(method, pattern, on(handler, opts)));

    add("GET", "/api/models", async (dir) => json({ models: await listModels(dir) }));

    add("POST", "/api/models", async (dir, req) => {
      const body = (await req.json().catch(() => null)) as { name?: unknown; model?: unknown } | null;
      if (typeof body?.name !== "string") return json({ error: "name is required" }, 400);
      return json({ fileName: await createModel(dir, body.name, body.model) }, 201);
    });

    add("GET", "/api/models/:file", async (dir, _req, params) => {
      const model = await readModel(dir, params.file ?? "");
      return model === null ? json({ error: "Model not found" }, 404) : json(model);
    });

    // The canvas's autosave: a local write through the model's document —
    // the reload cron commits and pushes it, like a saved scenario.
    add("PUT", "/api/models/:file", async (dir, req, params) => {
      const body = (await req.json().catch(() => null)) as { file?: unknown } | null;
      if (body?.file === null || typeof body?.file !== "object") {
        return json({ error: "file is required" }, 400);
      }
      return json(await saveModel(dir, params.file ?? "", body.file));
    });

    add("DELETE", "/api/models/:file", async (dir, _req, params) =>
      json(await deleteModel(dir, params.file ?? "")),
    );

    // The schema's half alone, as a download — what eventmodelers.ai and the
    // other tools that speak the published schema take.
    add("GET", "/api/models/:file/export", async (dir, _req, params) => {
      const model = await exportModel(dir, params.file ?? "");
      if (model === null) return json({ error: "Model not found" }, 404);
      const stem = (params.file ?? "").split("/").pop()!.replace(/\.model\.json$/, "");
      return new Response(serializeExport(model), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${stem}.eventmodel.json"`,
        },
      });
    });

    // The bridge to the specs (src/model/feature.ts): a slice
    // scaffolds its feature file — one scenario per Given / When / Then — and
    // is linked to it. The body may name the feature (with a `/` for a
    // folder); the slice's title otherwise. The canvas opens the new feature.
    add("POST", "/api/models/:file/slices/:slice/feature", async (dir, req, params) => {
      const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name : undefined;
      return json(await generateSliceFeature(dir, params.file ?? "", params.slice ?? "", name), 201);
    }, { notFound: true });

    // The sync tick (the app's src/server/reload.ts): the folder is made
    // when the repo has none, and the models' documents are kept in step
    // with their JSON.
    ctx.effect(() =>
      sync.drift(async (dir) => {
        await ensureModelsFolder(dir);
        return importModelDrift(dir);
      }),
    );

    // Turned on, the folder is made on the spot rather than on the next
    // tick; a repo that cannot be reached is left to that tick.
    void data
      .dir()
      .then((dir) => (dir ? ensureModelsFolder(dir) : false))
      .catch(() => false);

    // A `.feature.md` in the folder is not a stray spec, and a spec that
    // moved under `specs/` keeps the slices that link it.
    ctx.effect(() => sync.reserve(MODELS_FOLDER));
    ctx.effect(() =>
      sync.moved(async (dir, moved) => {
        await relinkModels(dir, moved);
      }),
    );

    // The Models tab's palette searches the models (`scope=models`).
    ctx.effect(() => ctx.need("search").add(MODELS_FOLDER, modelSearch));

    // A code gen session: the model open on the canvas goes into the prompt
    // after the specs, its linked specs whole, and so does any model whose
    // slice links a picked spec. A model alone is a session too.
    ctx.effect(() =>
      ctx.need("sessions").add("models", async (dir, { refs, specFiles }) => {
        const bundled = await sessionModels(dir, refs, specFiles);
        const withSpecs = specFiles.length > 0 || bundled.features.length > 0;
        return {
          sections: bundled.models.map((model) => modelSection(model, withSpecs)),
          features: bundled.features,
        };
      }),
    );
  },
};

export default plugin;
