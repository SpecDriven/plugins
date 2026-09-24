// The data repo's `storms` folder: one JSON file per Event Storming board,
// kept in an Automerge document behind the file, created and deleted with
// a commit and push, absorbed on the sync tick when edited from outside,
// searchable, carried into a code gen session — and all of it on routes
// that exist only while the plugin is mounted.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A, fileDocDirRel, loadFileDoc } from "@specdriven/host";
import { handleApi } from "@specdriven/app/src/server/api";
import { setGitEngine } from "@specdriven/app/src/server/git";
import { syncDataDir } from "@specdriven/app/src/server/reload";
import { isSearchScope, resetSearchCache, searchScope } from "@specdriven/app/src/server/search";
import { writeState } from "@specdriven/app/src/server/state";
import { parseRoute } from "@specdriven/app/src/frontend/route";
import { git, stopServers, twoClones } from "@specdriven/app/tests/helpers/fixtures";
import { docToStorm, importStormDoc, projectStorm, reconcileStorm, type StormDoc } from "../src/server/doc";
import { sessionStorms, stormSection } from "../src/server/session";
import {
  STORMS_FOLDER,
  createStorm,
  deleteStorm,
  importStormDrift,
  listStorms,
  readStorm,
  saveStorm,
} from "../src/server/storms";
import { parseStormsRoute, stormLink, stormsPath } from "../src/route";
import { normalizeStormFile, serializeStormFile } from "../src/storm/serialize";
import { emptyStormFile, type StormFile } from "../src/storm/types";
import { mountStorming } from "./app";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "specdriven-storms-"));
  resetSearchCache();
});

afterEach(async () => {
  stopServers();
  setGitEngine(null);
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return readdir(path).then(
    () => true,
    () => false,
  );
}

function orders(): StormFile {
  return normalizeStormFile({
    name: "Orders",
    stickies: [
      { id: "place", kind: "command", text: "Place order", x: 0, y: 0 },
      { id: "placed", kind: "event", text: "Order placed", x: 160, y: 0 },
    ],
    areas: [{ id: "sales", label: "Sales", x: -32, y: -32, width: 400, height: 240 }],
    arrows: [{ id: "r1", from: "place", to: "placed" }],
  });
}

test("a board's url is its path under the folder", () => {
  expect(stormLink("storms/orders.storm.json")).toBe("/storms/orders");
  expect(stormLink("storms/shop/a b.storm.json")).toBe("/storms/shop/a%20b");
  expect(parseStormsRoute("/storms/orders")).toEqual({ fileName: "storms/orders.storm.json" });
  expect(parseStormsRoute("/storms/shop/orders.storm.json")).toEqual({ fileName: "storms/shop/orders.storm.json" });
  expect(parseStormsRoute("/storms")).toEqual({ fileName: null });
  expect(parseStormsRoute("/stormsx")).toBeNull();
  // To the app's own router the url is home until the mounted tab claims it.
  expect(parseRoute("/storms/orders")).toEqual({});
  expect(stormsPath({ fileName: null })).toBe("/storms");
});

test("listStorms names the boards and counts their stickies, skipping what is not one", async () => {
  await mkdir(join(root, STORMS_FOLDER, "shop"), { recursive: true });
  await writeFile(join(root, STORMS_FOLDER, "orders.storm.json"), serializeStormFile(orders()));
  await writeFile(join(root, STORMS_FOLDER, "shop/no-name.storm.json"), '{"stickies": []}\n');
  await writeFile(join(root, STORMS_FOLDER, "broken.storm.json"), "{ nope");
  await writeFile(join(root, STORMS_FOLDER, "notes.md"), "# Notes\n");
  expect(await listStorms(root)).toEqual([
    { fileName: "storms/orders.storm.json", name: "Orders", counts: { command: 1, event: 1 } },
    { fileName: "storms/shop/no-name.storm.json", name: "No Name", counts: {} },
  ]);
});

test("a board is created, saved through its document, committed and pushed, and deleted", async () => {
  const clones = await twoClones(root);
  const fileName = await createStorm(clones.a, "Order flow");
  expect(fileName).toBe("storms/order-flow.storm.json");
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe(serializeStormFile(emptyStormFile("Order flow")));
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(true);
  expect(await exists(join(clones.b, fileDocDirRel(fileName)))).toBe(true);

  const saved = await saveStorm(clones.a, fileName, { ...orders(), name: "Order flow" });
  expect(saved.counts).toEqual({ command: 1, event: 1 });
  expect((await readStorm(clones.a, fileName))?.file).toEqual(saved.file);
  const loaded = await loadFileDoc<StormDoc>(clones.a, fileName);
  expect(loaded?.doc.stickies[1]?.text).toBe("Order placed");
  // The file is the document's projection, byte for byte.
  expect(await Bun.file(join(clones.a, fileName)).text()).toBe(projectStorm(loaded!.doc));

  await expect(createStorm(clones.a, "Order flow")).rejects.toThrow("already exists");
  await expect(createStorm(clones.a, "  ")).rejects.toThrow("name is required");

  await deleteStorm(clones.a, fileName);
  expect(await Bun.file(join(clones.a, fileName)).exists()).toBe(false);
  expect(await exists(join(clones.a, fileDocDirRel(fileName)))).toBe(false);
  await git(clones.b, "pull", "origin", "main");
  expect(await Bun.file(join(clones.b, fileName)).exists()).toBe(false);
  await expect(deleteStorm(clones.a, fileName)).rejects.toThrow("not found");
});

test("a board starts from the example or an import, and nests under a folder", async () => {
  const clones = await twoClones(root);
  const example = await createStorm(clones.a, "Online shop", { kind: "example" });
  expect((await readStorm(clones.a, example))?.file.stickies.length).toBeGreaterThan(10);
  const imported = await createStorm(clones.a, "shop/Imported", {
    kind: "import",
    data: [{ id: "1", name: "Paid", type: "event", x: 0, y: 0 }],
  });
  expect(imported).toBe("storms/shop/imported.storm.json");
  expect((await readStorm(clones.a, imported))?.file.stickies.map((s) => s.text)).toEqual(["Paid"]);
});

test("a board path outside the folder is refused", async () => {
  await expect(readStorm(root, "../secrets.storm.json")).rejects.toThrow("Invalid board name");
  await expect(readStorm(root, "storms/.hidden.storm.json")).rejects.toThrow("Invalid board name");
  await expect(readStorm(root, "storms/notes.md")).rejects.toThrow("Invalid board name");
});

test("an externally edited board is absorbed into its document; a broken one is left alone", async () => {
  await mkdir(join(root, STORMS_FOLDER), { recursive: true });
  const fileName = "storms/orders.storm.json";
  await writeFile(join(root, fileName), JSON.stringify(orders()));
  expect(await importStormDrift(root)).toContain("imported 1");
  // Rewritten to the canonical projection.
  expect(await Bun.file(join(root, fileName)).text()).toBe(serializeStormFile(orders()));
  expect(await importStormDrift(root)).toBe("");

  const edited = orders();
  edited.stickies[1]!.text = "Order submitted";
  edited.stickies.push({ id: "hot", kind: "hotspot", text: "Fraud?", x: 160, y: 200 });
  await writeFile(join(root, fileName), serializeStormFile(edited));
  expect(await importStormDrift(root)).toContain("absorbed 1");
  const loaded = await loadFileDoc<StormDoc>(root, fileName);
  expect(loaded?.doc.stickies.map((s) => s.text)).toEqual(["Place order", "Order submitted", "Fraud?"]);

  await writeFile(join(root, fileName), "{ half-typed");
  expect(await importStormDrift(root)).toContain("left 1");
  expect(await Bun.file(join(root, fileName)).text()).toBe("{ half-typed");

  await rm(join(root, fileName));
  expect(await importStormDrift(root)).toContain("dropped 1");
  expect(await loadFileDoc<StormDoc>(root, fileName)).toBeNull();
});

test("two people's edits to one wall both survive", () => {
  const base = importStormDoc(orders());
  // One moves a sticky and rewrites another; the other adds a sticky and renames the area.
  const a = reconcileStorm(A.clone(base), (() => {
    const f = docToStorm(base);
    f.stickies[0]!.x = 32;
    f.stickies[1]!.text = "Order submitted";
    return f;
  })());
  const b = reconcileStorm(A.clone(base), (() => {
    const f = docToStorm(base);
    f.stickies.push({ id: "actor", kind: "actor", text: "Customer", x: 0, y: -96 });
    f.areas[0]!.label = "Sales & marketing";
    return f;
  })());
  const merged = docToStorm(A.merge(a, b));
  expect(merged.stickies.map((s) => [s.id, s.text, s.x])).toEqual([
    ["place", "Place order", 32],
    ["placed", "Order submitted", 160],
    ["actor", "Customer", 0],
  ]);
  expect(merged.areas[0]!.label).toBe("Sales & marketing");
});

test("the tab searches the boards by name and by what is written on them", async () => {
  const unmount = await mountStorming();
  try {
    expect(isSearchScope(STORMS_FOLDER)).toBe(true);
    await mkdir(join(root, STORMS_FOLDER), { recursive: true });
    await writeFile(join(root, STORMS_FOLDER, "orders.storm.json"), serializeStormFile(orders()));
    await writeFile(join(root, STORMS_FOLDER, "billing.storm.json"), serializeStormFile(emptyStormFile("Billing")));
    const hits = await searchScope(root, STORMS_FOLDER, "placed");
    expect(hits.map((r) => [r.fileName, r.kind, r.featureName])).toEqual([
      ["storms/orders.storm.json", "storm", "Orders"],
    ]);
    expect((await searchScope(root, STORMS_FOLDER, "sales"))[0]?.fileName).toBe("storms/orders.storm.json");
    expect((await searchScope(root, STORMS_FOLDER, "billing")).map((r) => r.featureName)).toEqual(["Billing"]);
  } finally {
    await unmount();
  }
  expect(isSearchScope(STORMS_FOLDER)).toBe(false);
});

test("a code gen session over a board carries its outline and its JSON", async () => {
  await mkdir(join(root, STORMS_FOLDER), { recursive: true });
  await writeFile(join(root, STORMS_FOLDER, "orders.storm.json"), serializeStormFile(orders()));
  const [view] = await sessionStorms(root, ["storms/orders.storm.json"]);
  const section = stormSection(view!, false);
  expect(section.heading).toBe("Event Storming board: storms/orders.storm.json");
  const body = section.lines.join("\n");
  expect(body).toContain("- Order placed — in Sales\n  - after command “Place order”");
  expect(body).toContain('```json\n{\n  "format": "specdriven-event-storm/1"');
  await expect(sessionStorms(root, ["storms/gone.storm.json"])).rejects.toThrow("not found");
});

test("the routes exist while the plugin is mounted, and answer against the data repo", async () => {
  const clones = await twoClones(root);
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  const realRoot = process.env.SPECDRIVEN_ROOT;
  process.env.SPECDRIVEN_ROOT = appRoot;
  await writeState({ dataRepo: clones.a, reloadFrequencySeconds: 0 }, appRoot);
  const api = (path: string, init?: RequestInit) => handleApi(new Request(`http://x${path}`, init));
  const unmount = await mountStorming();
  try {
    expect((await (await api("/api/storms"))!.json())).toEqual({ storms: [] });
    const created = (await api("/api/storms", {
      method: "POST",
      body: JSON.stringify({ name: "Online shop", example: true }),
    }))!;
    expect(created.status).toBe(201);
    const { fileName } = (await created.json()) as { fileName: string };
    const url = `/api/storms/${encodeURIComponent(fileName)}`;
    const view = (await (await api(url))!.json()) as { name: string; file: StormFile };
    expect(view.name).toBe("Online shop");

    view.file.stickies = view.file.stickies.slice(0, 2);
    const put = (await api(url, { method: "PUT", body: JSON.stringify({ file: view.file }) }))!;
    expect(put.status).toBe(200);
    expect(((await put.json()) as { file: StormFile }).file.stickies).toHaveLength(2);

    const exported = (await api(`${url}/export`))!;
    expect(exported.headers.get("Content-Disposition")).toBe('attachment; filename="online-shop.storm.json"');
    expect(await exported.text()).toBe(await Bun.file(join(clones.a, fileName)).text());

    expect((await api("/api/storms", { method: "POST", body: "{}" }))!.status).toBe(400);
    expect((await api("/api/storms/storms%2Fgone.storm.json"))!.status).toBe(404);
    expect((await api("/api/storms/..%2Fx.storm.json"))!.status).toBe(400);
    expect((await api(url, { method: "DELETE" }))!.status).toBe(200);
    expect((await api(url))!.status).toBe(404);

    // The sync tick runs the plugin's drift pass.
    await mkdir(join(clones.a, STORMS_FOLDER), { recursive: true });
    await writeFile(join(clones.a, STORMS_FOLDER, "hand.storm.json"), JSON.stringify(orders()));
    await syncDataDir(clones.a);
    expect(await Bun.file(join(clones.a, STORMS_FOLDER, "hand.storm.json")).text()).toBe(serializeStormFile(orders()));
  } finally {
    await unmount();
    if (realRoot === undefined) delete process.env.SPECDRIVEN_ROOT;
    else process.env.SPECDRIVEN_ROOT = realRoot;
  }
  expect(await api("/api/storms")).toBeNull();
});
