// The Event Storming plugin's host half: the JSON files in the data repo's
// `storms` folder, each a board drawn on the tab's wall, on routes that
// exist only while the plugin is mounted — list, create, read, save,
// delete and export. And what the app asks of a plugin with files of its
// own: the folder kept in step with its documents on every sync tick, the
// `storms` search scope the tab's palette searches, and the board a code
// gen session bundles.

import { json, type Context, type DataAccess, type Handler, type Params, type Plugin } from "@specdriven/host";
import { serializeStormFile } from "./storm/serialize";
import { STORMS_FOLDER } from "./route";
import { stormSearch } from "./server/search";
import { sessionStorms, stormSection } from "./server/session";
import {
  createStorm,
  deleteStorm,
  importStormDrift,
  listStorms,
  readStorm,
  saveStorm,
  type StormSeed,
} from "./server/storms";

type DirHandler = (dir: string, req: Request, params: Params) => Response | Promise<Response>;

/** Against the data dir, with the module's errors as 400 answers — 404 when
    the message says the thing is not there. */
const guarded =
  (data: DataAccess) =>
  (handler: DirHandler): Handler =>
    data.withDir(async (dir, req, params) => {
      try {
        return await handler(dir, req, params);
      } catch (e) {
        const message = (e as Error).message;
        return json({ error: message }, /not found/i.test(message) ? 404 : 400);
      }
    });

/** What a create request's body asks the board to start from. */
function seedOf(body: { example?: unknown; import?: unknown }): StormSeed {
  if (body.import !== undefined) return { kind: "import", data: body.import };
  if (body.example === true) return { kind: "example" };
  return { kind: "empty" };
}

const plugin: Plugin<Context> = {
  name: "event-storming",
  inject: ["routes", "data", "sync", "search", "sessions"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const sync = ctx.need("sync");
    const on = guarded(ctx.need("data"));
    const add = (method: string, pattern: string, handler: DirHandler) =>
      ctx.effect(() => routes.add(method, pattern, on(handler)));

    add("GET", "/api/storms", async (dir) => json({ storms: await listStorms(dir) }));

    // `{ name }` for an empty board, `example: true` for the sample one,
    // `import: <json>` for a board brought from elsewhere.
    add("POST", "/api/storms", async (dir, req) => {
      const body = (await req.json().catch(() => null)) as
        | { name?: unknown; example?: unknown; import?: unknown }
        | null;
      if (typeof body?.name !== "string") return json({ error: "name is required" }, 400);
      return json({ fileName: await createStorm(dir, body.name, seedOf(body)) }, 201);
    });

    add("GET", "/api/storms/:file", async (dir, _req, params) => {
      const view = await readStorm(dir, params.file ?? "");
      return view === null ? json({ error: "Board not found" }, 404) : json(view);
    });

    // The wall's autosave: a local write through the board's document —
    // the reload cron commits and pushes it, like a saved scenario.
    add("PUT", "/api/storms/:file", async (dir, req, params) => {
      const body = (await req.json().catch(() => null)) as { file?: unknown } | null;
      if (body?.file === null || typeof body?.file !== "object") {
        return json({ error: "file is required" }, 400);
      }
      return json(await saveStorm(dir, params.file ?? "", body.file));
    });

    add("DELETE", "/api/storms/:file", async (dir, _req, params) => json(await deleteStorm(dir, params.file ?? "")));

    // The board as a download, to keep or to import elsewhere.
    add("GET", "/api/storms/:file/export", async (dir, _req, params) => {
      const view = await readStorm(dir, params.file ?? "");
      if (view === null) return json({ error: "Board not found" }, 404);
      const stem = view.fileName.split("/").pop()!;
      return new Response(serializeStormFile(view.file), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${stem}"`,
        },
      });
    });

    // The sync tick (the app's src/server/reload.ts): the boards' documents
    // are kept in step with their JSON.
    ctx.effect(() => sync.drift(importStormDrift));
    // Not a stray spec folder for the specs-folder migration to sweep.
    ctx.effect(() => sync.reserve(STORMS_FOLDER));

    // The tab's palette searches the boards (`scope=storms`).
    ctx.effect(() => ctx.need("search").add(STORMS_FOLDER, stormSearch));

    // A code gen session started on a board carries it in the prompt.
    ctx.effect(() =>
      ctx.need("sessions").add("event-storming", async (dir, { refs, specFiles }) => {
        const views = await sessionStorms(dir, refs);
        return { sections: views.map((v) => stormSection(v, specFiles.length > 0)), features: [] };
      }),
    );
  },
};

export default plugin;
