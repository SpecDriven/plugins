// specdriven-shim:@specdriven/host
var m = globalThis.__specdriven?.modules?.["@specdriven/host"];
if (!m)
  throw new Error("SpecDriven did not publish @specdriven/host for plugins");
var host_default = m.default ?? m;
var A = m.A;
var commitAndPush = m.commitAndPush;
var createFeature = m.createFeature;
var createFileDoc = m.createFileDoc;
var fileDocDirRel = m.fileDocDirRel;
var fileExists = m.fileExists;
var getLogger = m.getLogger;
var hasFileDoc = m.hasFileDoc;
var json = m.json;
var listFileDocs = m.listFileDocs;
var loadFileDoc = m.loadFileDoc;
var newFileDoc = m.newFileDoc;
var readTextFile = m.readTextFile;
var removeAndPush = m.removeAndPush;
var removeFileDoc = m.removeFileDoc;
var saveFileDoc = m.saveFileDoc;
var slugify = m.slugify;
var titleFromFileName = m.titleFromFileName;
var withSpan = m.withSpan;
var writeTextFile = m.writeTextFile;

// src/storm/types.ts
var STORM_FORMAT = "specdriven-event-storm/1";
var STICKY_KINDS = [
  "event",
  "command",
  "actor",
  "policy",
  "aggregate",
  "readmodel",
  "external",
  "hotspot",
  "note"
];
var STICKY = {
  event: {
    label: "Domain event",
    plural: "Domain events",
    color: "#ffa94d",
    ink: "#3d2300",
    width: 128,
    height: 128,
    meaning: "Something that happened that the business cares about, in the past tense.",
    example: "Order placed"
  },
  command: {
    label: "Command",
    plural: "Commands",
    color: "#74c0fc",
    ink: "#0b2a44",
    width: 128,
    height: 128,
    meaning: "A decision or intention that causes an event, in the imperative.",
    example: "Place order"
  },
  actor: {
    label: "Actor",
    plural: "Actors",
    color: "#fff3bf",
    ink: "#3d3200",
    width: 96,
    height: 64,
    meaning: "The person or role who issues a command.",
    example: "Customer"
  },
  policy: {
    label: "Policy",
    plural: "Policies",
    color: "#d0bfff",
    ink: "#2b1a55",
    width: 128,
    height: 128,
    meaning: "A reaction: whenever an event happens, then a command — a rule, a process, an automation.",
    example: "Whenever payment fails, notify the customer"
  },
  aggregate: {
    label: "Aggregate",
    plural: "Aggregates",
    color: "#ffe066",
    ink: "#3d3200",
    width: 160,
    height: 160,
    meaning: "What takes a command and decides which events follow — the rules' keeper.",
    example: "Order"
  },
  readmodel: {
    label: "Read model",
    plural: "Read models",
    color: "#8ce99a",
    ink: "#0e3a17",
    width: 128,
    height: 128,
    meaning: "The information someone looks at to make a decision.",
    example: "Order summary"
  },
  external: {
    label: "External system",
    plural: "External systems",
    color: "#f783ac",
    ink: "#4a0a24",
    width: 176,
    height: 112,
    meaning: "A system outside the domain that events come from or commands go to.",
    example: "Payment provider"
  },
  hotspot: {
    label: "Hotspot",
    plural: "Hotspots",
    color: "#e64980",
    ink: "#ffffff",
    width: 128,
    height: 128,
    meaning: "A problem, question, risk or disagreement to come back to.",
    example: "What if the stock ran out?"
  },
  note: {
    label: "Note",
    plural: "Notes",
    color: "#f8f9fa",
    ink: "#212529",
    width: 128,
    height: 96,
    meaning: "Anything else worth writing down — an opportunity, a comment, a question for later.",
    example: "Ask finance"
  }
};
function isStickyKind(value) {
  return typeof value === "string" && STICKY_KINDS.includes(value);
}
function emptyStormFile(name) {
  return { format: STORM_FORMAT, name, stickies: [], areas: [], arrows: [] };
}
var MIN_AREA = { width: 160, height: 120 };

// src/storm/serialize.ts
var KEY_ORDER = [
  "format",
  "name",
  "id",
  "kind",
  "label",
  "text",
  "pivotal",
  "x",
  "y",
  "width",
  "height",
  "from",
  "to",
  "stickies",
  "areas",
  "arrows"
];
var RANK = new Map(KEY_ORDER.map((key, i) => [key, i]));
function compareKeys(a, b) {
  const ra = RANK.get(a);
  const rb = RANK.get(b);
  if (ra !== undefined && rb !== undefined)
    return ra - rb;
  if (ra !== undefined)
    return -1;
  if (rb !== undefined)
    return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function canonical(value) {
  if (Array.isArray(value))
    return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort(compareKeys)) {
      const v = value[key];
      if (v !== undefined)
        out[key] = canonical(v);
    }
    return out;
  }
  return value;
}
function serializeStormFile(file) {
  return `${JSON.stringify(canonical(normalizeStormFile(file, file.name)), null, 2)}
`;
}
function stormTextError(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return `not JSON (${e.message})`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  const format = parsed.format;
  if (format !== undefined && format !== STORM_FORMAT)
    return `unknown format ${JSON.stringify(format)}`;
  return null;
}
function parseStormFile(text, fallbackName = "") {
  return normalizeStormFile(JSON.parse(text), fallbackName);
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function list(value) {
  return Array.isArray(value) ? value.map(record) : [];
}
function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
function normalizeStormFile(raw, fallbackName = "") {
  const r = record(raw);
  const seen = new Set;
  const unique = (id, prefix) => {
    let out = typeof id === "string" && id.trim() ? id.trim() : newId(prefix);
    while (seen.has(out))
      out = newId(prefix);
    seen.add(out);
    return out;
  };
  const stickies = list(r.stickies).map((s) => ({
    id: unique(s.id, "s"),
    kind: isStickyKind(s.kind) ? s.kind : "note",
    text: str(s.text),
    x: num(s.x),
    y: num(s.y),
    ...s.pivotal === true && s.kind === "event" ? { pivotal: true } : {}
  }));
  const areas = list(r.areas).map((a) => ({
    id: unique(a.id, "a"),
    label: str(a.label),
    x: num(a.x),
    y: num(a.y),
    width: Math.max(MIN_AREA.width, num(a.width, MIN_AREA.width * 2)),
    height: Math.max(MIN_AREA.height, num(a.height, MIN_AREA.height * 2))
  }));
  const ids = new Set(stickies.map((s) => s.id));
  const pairs = new Set;
  const arrows = [];
  for (const a of list(r.arrows)) {
    const from = str(a.from);
    const to = str(a.to);
    if (!ids.has(from) || !ids.has(to) || from === to || pairs.has(`${from}>${to}`))
      continue;
    pairs.add(`${from}>${to}`);
    arrows.push({ id: unique(a.id, "r"), from, to });
  }
  return {
    format: STORM_FORMAT,
    name: str(r.name) || fallbackName,
    stickies,
    areas,
    arrows
  };
}
var EVENTSTORM_KINDS = {
  actor: "actor",
  aggregate: "aggregate",
  process: "policy",
  command: "command",
  error: "hotspot",
  event: "event",
  external: "external",
  view: "readmodel"
};
function importStorm(raw, name) {
  if (Array.isArray(raw)) {
    const stickies = raw.map(record).map((n) => ({
      id: str(n.id),
      kind: EVENTSTORM_KINDS[str(n.type)] ?? "note",
      text: str(n.name),
      x: num(n.x),
      y: num(n.y)
    }));
    return normalizeStormFile({ name, stickies }, name);
  }
  const r = record(raw);
  if (!Array.isArray(r.stickies))
    throw new Error("Not an Event Storming board: it has no stickies");
  const file = normalizeStormFile(raw, name);
  file.name = name;
  return file;
}

// src/route.ts
var STORMS_FOLDER = "storms";
var STORM_SUFFIX = ".storm.json";

// src/server/storms.ts
import { mkdir, readdir } from "node:fs/promises";

// src/server/doc.ts
var STORM_SCHEMA_VERSION = 1;
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function docToStorm(doc) {
  return {
    format: STORM_FORMAT,
    name: doc.name,
    stickies: plain(doc.stickies),
    areas: plain(doc.areas),
    arrows: plain(doc.arrows)
  };
}
function projectStorm(doc) {
  return serializeStormFile(docToStorm(doc));
}
function isStormProjectionOf(text, doc) {
  return text === projectStorm(doc);
}
function importStormDoc(file) {
  return newFileDoc(STORM_SCHEMA_VERSION, {
    name: file.name,
    stickies: plain(file.stickies),
    areas: plain(file.areas),
    arrows: plain(file.arrows)
  });
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keyed(list2) {
  return list2.length > 0 && list2.every((item) => isRecord(item) && typeof item.id === "string");
}
function at(root, path) {
  let node = root;
  for (const key of path)
    node = node[key];
  return node;
}
function reconcileValue(root, path, current, target) {
  if (typeof target === "string" && typeof current === "string") {
    if (current !== target)
      A.updateText(root, path, target);
    return;
  }
  if (Array.isArray(target) && Array.isArray(current)) {
    if (keyed(target) && (current.length === 0 || keyed(current))) {
      reconcileList(root, path, current, target);
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(target))
      set(root, path, target);
    return;
  }
  if (isRecord(target) && isRecord(current)) {
    for (const key of Object.keys(current)) {
      if (target[key] === undefined)
        delete at(root, path)[key];
    }
    for (const [key, value] of Object.entries(target)) {
      if (value === undefined)
        continue;
      if (current[key] === undefined)
        set(root, [...path, key], value);
      else
        reconcileValue(root, [...path, key], current[key], value);
    }
    return;
  }
  if (current !== target)
    set(root, path, target);
}
function set(root, path, value) {
  const parent = at(root, path.slice(0, -1));
  parent[path[path.length - 1]] = plain(value);
}
function reconcileList(root, path, current, target) {
  const list2 = at(root, path);
  const wanted = new Set(target.map((item) => item.id));
  const kept = [];
  for (let i = current.length - 1;i >= 0; i--) {
    if (!wanted.has(current[i].id))
      list2.splice(i, 1);
    else
      kept.unshift(current[i]);
  }
  const live = [...kept];
  target.forEach((item, index) => {
    const have = live.findIndex((k) => k.id === item.id);
    if (have === -1) {
      list2.splice(index, 0, plain(item));
      live.splice(index, 0, item);
      return;
    }
    if (have !== index) {
      list2.splice(have, 1);
      list2.splice(index, 0, plain(item));
      live.splice(have, 1);
      live.splice(index, 0, item);
      return;
    }
    reconcileValue(root, [...path, index], live[index], item);
    live[index] = item;
  });
}
function reconcileStorm(doc, target) {
  const current = docToStorm(doc);
  return A.change(doc, (d) => {
    if (d.name !== target.name)
      A.updateText(d, ["name"], target.name);
    reconcileValue(d, ["stickies"], current.stickies, target.stickies);
    reconcileValue(d, ["areas"], current.areas, target.areas);
    reconcileValue(d, ["arrows"], current.arrows, target.arrows);
  });
}

// src/storm/example.ts
var col = (i) => i * 176;
function exampleStorm(name) {
  return normalizeStormFile({
    name,
    stickies: [
      { id: "customer", kind: "actor", text: "Customer", x: col(0) + 16, y: 96 },
      { id: "place-order", kind: "command", text: "Place order", x: col(0), y: 176 },
      { id: "order", kind: "aggregate", text: "Order", x: col(1), y: 160 },
      { id: "order-placed", kind: "event", text: "Order placed", x: col(2) + 16, y: 176 },
      { id: "take-payment-policy", kind: "policy", text: "Whenever an order is placed, take payment", x: col(3) + 16, y: 176 },
      { id: "payment-provider", kind: "external", text: "Payment provider", x: col(4), y: 40 },
      { id: "take-payment", kind: "command", text: "Take payment", x: col(4) + 16, y: 176 },
      { id: "payment-received", kind: "event", text: "Payment received", x: col(5) + 16, y: 176, pivotal: true },
      { id: "payment-fails", kind: "hotspot", text: "What if the payment fails?", x: col(5) + 16, y: 352 },
      { id: "orders-to-pack", kind: "readmodel", text: "Orders to pack", x: col(6) + 24, y: 176 },
      { id: "clerk", kind: "actor", text: "Warehouse clerk", x: col(7) + 16, y: 96 },
      { id: "ship-order", kind: "command", text: "Ship order", x: col(7), y: 176 },
      { id: "order-shipped", kind: "event", text: "Order shipped", x: col(8), y: 176 },
      { id: "carrier", kind: "external", text: "Carrier", x: col(8) - 24, y: 352 }
    ],
    areas: [
      { id: "sales", label: "Sales", x: -32, y: 16, width: 1080, height: 512 },
      { id: "fulfilment", label: "Fulfilment", x: 1064, y: 16, width: 520, height: 512 }
    ],
    arrows: [
      { id: "r1", from: "customer", to: "place-order" },
      { id: "r2", from: "place-order", to: "order" },
      { id: "r3", from: "order", to: "order-placed" },
      { id: "r4", from: "order-placed", to: "take-payment-policy" },
      { id: "r5", from: "take-payment-policy", to: "take-payment" },
      { id: "r6", from: "take-payment", to: "payment-received" },
      { id: "r7", from: "payment-received", to: "orders-to-pack" },
      { id: "r8", from: "orders-to-pack", to: "ship-order" },
      { id: "r9", from: "clerk", to: "ship-order" },
      { id: "r10", from: "ship-order", to: "order-shipped" }
    ]
  }, name);
}

// src/server/storms.ts
var log = getLogger("event-storming");
function isStormFile(fileName) {
  return fileName.endsWith(STORM_SUFFIX);
}
async function listStorms(dataDir) {
  const out = [];
  for (const fileName of await stormFiles(dataDir, STORMS_FOLDER)) {
    const text = await readTextFile(`${dataDir}/${fileName}`);
    if (text === null || stormTextError(text) !== null)
      continue;
    out.push(listing(fileName, parseStormFile(text, fallbackName(fileName))));
  }
  return out;
}
async function readStorm(dataDir, fileName) {
  const file = safe(fileName);
  const text = await readTextFile(`${dataDir}/${file}`);
  if (text === null)
    return null;
  const error = stormTextError(text);
  if (error !== null)
    throw new Error(`Board ${file} is unreadable: ${error}`);
  const parsed = parseStormFile(text, fallbackName(file));
  return { ...listing(file, parsed), file: parsed };
}
async function saveStorm(dataDir, fileName, raw) {
  const file = safe(fileName);
  const wanted = normalizeStormFile(raw, fallbackName(file));
  const projection = await absorb(dataDir, file, wanted);
  await writeTextFile(`${dataDir}/${file}`, projection);
  const parsed = parseStormFile(projection, fallbackName(file));
  return { ...listing(file, parsed), file: parsed };
}
async function createStorm(dataDir, name, seed = { kind: "empty" }) {
  const segments = name.split("/").map((s) => s.trim());
  const boardName = segments.pop() ?? "";
  const stem = slugify(boardName);
  if (!boardName || !stem)
    throw new Error("Board name is required");
  const folder = [STORMS_FOLDER, ...segments.map(slugify).filter(Boolean)].join("/");
  const fileName = safe(`${folder}/${stem}${STORM_SUFFIX}`);
  if (await fileExists(`${dataDir}/${fileName}`)) {
    throw new Error(`Board already exists: ${fileName}`);
  }
  const file = seed.kind === "example" ? exampleStorm(boardName) : seed.kind === "import" ? importStorm(seed.data, boardName) : emptyStormFile(boardName);
  await mkdir(`${dataDir}/${folder}`, { recursive: true });
  const projection = await absorb(dataDir, fileName, file);
  await writeTextFile(`${dataDir}/${fileName}`, projection);
  await commitAndPush(dataDir, await stormPaths(dataDir, fileName), `Create Event Storming board: ${boardName}`);
  log.info("created a board", { "specdriven.file": fileName, "specdriven.seed": seed.kind });
  return fileName;
}
async function deleteStorm(dataDir, fileName) {
  const file = safe(fileName);
  if (!await fileExists(`${dataDir}/${file}`))
    throw new Error(`Board not found: ${file}`);
  const paths = await stormPaths(dataDir, file);
  const sync = await removeAndPush(dataDir, paths, `Delete Event Storming board: ${file}`);
  await removeFileDoc(dataDir, file);
  return { message: sync.message };
}
async function importStormDrift(dataDir) {
  return withSpan("sync.import_storm_drift", { "specdriven.dir": dataDir }, async (span) => {
    let imported = 0;
    let absorbed = 0;
    let skipped = 0;
    for (const fileName of await stormFiles(dataDir, STORMS_FOLDER)) {
      const text = await readTextFile(`${dataDir}/${fileName}`);
      if (text === null)
        continue;
      const error = stormTextError(text);
      if (error !== null) {
        skipped++;
        log.warn(`left ${fileName} alone: ${error}`);
        continue;
      }
      const loaded = await loadFileDoc(dataDir, fileName);
      if (loaded === null) {
        const created = await createFileDoc(dataDir, fileName, importStormDoc(parseStormFile(text, fallbackName(fileName))));
        const projection = projectStorm(created.doc);
        if (projection !== text)
          await writeTextFile(`${dataDir}/${fileName}`, projection);
        imported++;
        continue;
      }
      if (isStormProjectionOf(text, loaded.doc))
        continue;
      const next = reconcileStorm(loaded.doc, parseStormFile(text, fallbackName(fileName)));
      await saveFileDoc(dataDir, fileName, next, loaded.heads);
      await writeTextFile(`${dataDir}/${fileName}`, projectStorm(next));
      absorbed++;
    }
    let removed = 0;
    for (const fileName of await listFileDocs(dataDir, STORMS_FOLDER, STORM_SUFFIX)) {
      if (!await fileExists(`${dataDir}/${fileName}`)) {
        await removeFileDoc(dataDir, fileName);
        removed++;
      }
    }
    span.setAttributes({
      "sync.storms_imported": imported,
      "sync.storms_absorbed": absorbed,
      "sync.storms_skipped": skipped,
      "sync.storms_removed": removed
    });
    const parts = [];
    if (imported > 0)
      parts.push(`imported ${imported} Event Storming board(s) into documents`);
    if (absorbed > 0)
      parts.push(`absorbed ${absorbed} externally edited board(s)`);
    if (skipped > 0)
      parts.push(`left ${skipped} unreadable board file(s) alone`);
    if (removed > 0)
      parts.push(`dropped ${removed} document(s) for deleted boards`);
    return parts.join("; ");
  });
}
async function absorb(dataDir, fileName, file) {
  const loaded = await loadFileDoc(dataDir, fileName);
  if (loaded === null) {
    const created = await createFileDoc(dataDir, fileName, importStormDoc(file));
    return projectStorm(created.doc);
  }
  const next = reconcileStorm(loaded.doc, file);
  await saveFileDoc(dataDir, fileName, next, loaded.heads);
  return projectStorm(next);
}
async function stormPaths(dataDir, fileName) {
  return await hasFileDoc(dataDir, fileName) ? [fileName, fileDocDirRel(fileName)] : [fileName];
}
function listing(fileName, file) {
  const counts = {};
  for (const s of file.stickies)
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return { fileName, name: file.name || fallbackName(fileName), counts };
}
function fallbackName(fileName) {
  return titleFromFileName(fileName.replace(/\.storm\.json$/, ""));
}
async function stormFiles(dataDir, rel) {
  let entries;
  try {
    entries = await readdir(`${dataDir}/${rel}`, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith("."))
      continue;
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory())
      files.push(...await stormFiles(dataDir, path));
    else if (isStormFile(entry.name))
      files.push(path);
  }
  return files.sort();
}
function badSegment(segment) {
  return !segment || segment.startsWith(".") || segment.includes("\\");
}
function safe(fileName) {
  const segments = fileName.split("/");
  if (segments.length < 2 || segments[0] !== STORMS_FOLDER || segments.some(badSegment) || !isStormFile(segments[segments.length - 1])) {
    throw new Error(`Invalid board name: ${fileName}`);
  }
  return fileName;
}

// src/server/search.ts
var stormSearch = {
  kind: "storm",
  files: (dataDir) => stormFiles(dataDir, STORMS_FOLDER),
  document(fileName, content) {
    if (stormTextError(content) !== null)
      return null;
    const file = parseStormFile(content);
    const name = file.name || titleFromFileName(fileName.replace(/\.storm\.json$/, ""));
    const words = [...file.stickies.map((s) => s.text), ...file.areas.map((a) => a.label)];
    return { name, text: words.filter((w) => w.trim()).join(" · ") };
  }
};

// src/storm/outline.ts
function areaOf(sticky, areas) {
  const { width, height } = STICKY[sticky.kind];
  const cx = sticky.x + width / 2;
  const cy = sticky.y + height / 2;
  let best = null;
  for (const area of areas) {
    const inside = cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height;
    if (inside && (best === null || area.width * area.height < best.width * best.height))
      best = area;
  }
  return best;
}
function readingOrder(a, b) {
  return a.x - b.x || a.y - b.y;
}
var oneLine = (text) => text.replace(/\s+/g, " ").trim() || "(blank)";
function stormOutline(file) {
  const byId = new Map(file.stickies.map((s) => [s.id, s]));
  const where = (s) => {
    const area = areaOf(s, file.areas);
    return area?.label.trim() ? ` — in ${oneLine(area.label)}` : "";
  };
  const lines = [`# ${file.name || "Event Storming board"}`, ""];
  const events = file.stickies.filter((s) => s.kind === "event").sort(readingOrder);
  lines.push("## Timeline", "");
  if (events.length === 0)
    lines.push("(no domain events yet)");
  let phase = 1;
  const pivotalCount = events.filter((e) => e.pivotal).length;
  if (pivotalCount > 0 && events.length > 0)
    lines.push(`### Phase ${phase}`, "");
  for (const [i, event] of events.entries()) {
    lines.push(`- ${oneLine(event.text)}${event.pivotal ? " (pivotal)" : ""}${where(event)}`);
    for (const arrow of file.arrows.filter((a) => a.to === event.id)) {
      const from = byId.get(arrow.from);
      if (from)
        lines.push(`  - after ${STICKY[from.kind].label.toLowerCase()} “${oneLine(from.text)}”`);
    }
    for (const arrow of file.arrows.filter((a) => a.from === event.id)) {
      const to = byId.get(arrow.to);
      if (to)
        lines.push(`  - then ${STICKY[to.kind].label.toLowerCase()} “${oneLine(to.text)}”`);
    }
    if (event.pivotal && i < events.length - 1) {
      phase += 1;
      lines.push("", `### Phase ${phase}`, "");
    }
  }
  for (const kind of STICKY_KINDS) {
    if (kind === "event")
      continue;
    const stickies = file.stickies.filter((s) => s.kind === kind).sort(readingOrder);
    if (stickies.length === 0)
      continue;
    lines.push("", `## ${STICKY[kind].plural}`, "");
    for (const s of stickies)
      lines.push(`- ${oneLine(s.text)}${where(s)}`);
  }
  const areas = file.areas.filter((a) => a.label.trim());
  if (areas.length > 0) {
    lines.push("", "## Areas", "");
    for (const area of areas) {
      const inside = file.stickies.filter((s) => areaOf(s, file.areas) === area).length;
      lines.push(`- ${oneLine(area.label)} (${inside} sticky note${inside === 1 ? "" : "s"})`);
    }
  }
  return `${lines.join(`
`)}
`;
}

// src/server/session.ts
async function sessionStorms(dataDir, wanted) {
  const views = [];
  for (const fileName of new Set(wanted)) {
    const view = await readStorm(dataDir, fileName);
    if (view === null)
      throw new Error(`Event Storming board not found: ${fileName}`);
    views.push(view);
  }
  return views;
}
function stormSection(view, withSpecs) {
  const lines = [
    `The Event Storming board "${view.name}"${withSpecs ? " the specifications above belong to" : ""}: ` + "a workshop's wall of sticky notes read left to right as time — domain events (orange), the " + "commands (blue) and actors (small yellow) behind them, policies (lilac), aggregates (big " + "yellow), read models (green), external systems (pink) and hotspots (magenta) — with the areas " + "drawn round them. Its outline:",
    "",
    ...stormOutline(view.file).trimEnd().split(`
`),
    "",
    "The board as JSON:",
    "",
    "```json",
    serializeStormFile(view.file).trimEnd(),
    "```"
  ];
  return {
    heading: `Event Storming board: ${view.fileName}`,
    noun: { one: "Event Storming board", many: "Event Storming boards" },
    lines
  };
}

// src/host.ts
var guarded = (data) => (handler) => data.withDir(async (dir, req, params) => {
  try {
    return await handler(dir, req, params);
  } catch (e) {
    const message = e.message;
    return json({ error: message }, /not found/i.test(message) ? 404 : 400);
  }
});
function seedOf(body) {
  if (body.import !== undefined)
    return { kind: "import", data: body.import };
  if (body.example === true)
    return { kind: "example" };
  return { kind: "empty" };
}
var plugin = {
  name: "event-storming",
  inject: ["routes", "data", "sync", "search", "sessions"],
  apply(ctx) {
    const routes = ctx.need("routes");
    const sync = ctx.need("sync");
    const on = guarded(ctx.need("data"));
    const add = (method, pattern, handler) => ctx.effect(() => routes.add(method, pattern, on(handler)));
    add("GET", "/api/storms", async (dir) => json({ storms: await listStorms(dir) }));
    add("POST", "/api/storms", async (dir, req) => {
      const body = await req.json().catch(() => null);
      if (typeof body?.name !== "string")
        return json({ error: "name is required" }, 400);
      return json({ fileName: await createStorm(dir, body.name, seedOf(body)) }, 201);
    });
    add("GET", "/api/storms/:file", async (dir, _req, params) => {
      const view = await readStorm(dir, params.file ?? "");
      return view === null ? json({ error: "Board not found" }, 404) : json(view);
    });
    add("PUT", "/api/storms/:file", async (dir, req, params) => {
      const body = await req.json().catch(() => null);
      if (body?.file === null || typeof body?.file !== "object") {
        return json({ error: "file is required" }, 400);
      }
      return json(await saveStorm(dir, params.file ?? "", body.file));
    });
    add("DELETE", "/api/storms/:file", async (dir, _req, params) => json(await deleteStorm(dir, params.file ?? "")));
    add("GET", "/api/storms/:file/export", async (dir, _req, params) => {
      const view = await readStorm(dir, params.file ?? "");
      if (view === null)
        return json({ error: "Board not found" }, 404);
      const stem = view.fileName.split("/").pop();
      return new Response(serializeStormFile(view.file), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${stem}"`
        }
      });
    });
    ctx.effect(() => sync.drift(importStormDrift));
    ctx.effect(() => sync.reserve(STORMS_FOLDER));
    ctx.effect(() => ctx.need("search").add(STORMS_FOLDER, stormSearch));
    ctx.effect(() => ctx.need("sessions").add("event-storming", async (dir, { refs, specFiles }) => {
      const views = await sessionStorms(dir, refs);
      return { sections: views.map((v) => stormSection(v, specFiles.length > 0)), features: [] };
    }));
  }
};
var host_default2 = plugin;
export {
  host_default2 as default
};

//# debugId=2C3C4739BFC0E83464756E2164756E21
//# sourceMappingURL=host.js.map
