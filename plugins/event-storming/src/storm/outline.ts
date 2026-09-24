// A board read out as Markdown: the timeline of domain events left to
// right, cut into phases at the pivotal ones, each event with the area it
// sits in and what its arrows say led to it; then everything else on the
// wall by kind. What "Copy as Markdown" puts on the clipboard, and what a
// code gen session reads before the board's JSON (server/session.ts) — the
// story first, so an agent can place every spec in it.

import { STICKY, STICKY_KINDS, type Area, type Sticky, type StormFile } from "./types";

/** The area whose rectangle holds the sticky's centre; the smallest wins. */
export function areaOf(sticky: Sticky, areas: Area[]): Area | null {
  const { width, height } = STICKY[sticky.kind];
  const cx = sticky.x + width / 2;
  const cy = sticky.y + height / 2;
  let best: Area | null = null;
  for (const area of areas) {
    const inside = cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height;
    if (inside && (best === null || area.width * area.height < best.width * best.height)) best = area;
  }
  return best;
}

/** Left to right, then top to bottom — the order the wall is read in. */
export function readingOrder(a: Sticky, b: Sticky): number {
  return a.x - b.x || a.y - b.y;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim() || "(blank)";

export function stormOutline(file: StormFile): string {
  const byId = new Map(file.stickies.map((s) => [s.id, s]));
  const where = (s: Sticky) => {
    const area = areaOf(s, file.areas);
    return area?.label.trim() ? ` — in ${oneLine(area.label)}` : "";
  };
  const lines = [`# ${file.name || "Event Storming board"}`, ""];

  const events = file.stickies.filter((s) => s.kind === "event").sort(readingOrder);
  lines.push("## Timeline", "");
  if (events.length === 0) lines.push("(no domain events yet)");
  let phase = 1;
  const pivotalCount = events.filter((e) => e.pivotal).length;
  if (pivotalCount > 0 && events.length > 0) lines.push(`### Phase ${phase}`, "");
  for (const [i, event] of events.entries()) {
    lines.push(`- ${oneLine(event.text)}${event.pivotal ? " (pivotal)" : ""}${where(event)}`);
    for (const arrow of file.arrows.filter((a) => a.to === event.id)) {
      const from = byId.get(arrow.from);
      if (from) lines.push(`  - after ${STICKY[from.kind].label.toLowerCase()} “${oneLine(from.text)}”`);
    }
    for (const arrow of file.arrows.filter((a) => a.from === event.id)) {
      const to = byId.get(arrow.to);
      if (to) lines.push(`  - then ${STICKY[to.kind].label.toLowerCase()} “${oneLine(to.text)}”`);
    }
    if (event.pivotal && i < events.length - 1) {
      phase += 1;
      lines.push("", `### Phase ${phase}`, "");
    }
  }

  for (const kind of STICKY_KINDS) {
    if (kind === "event") continue;
    const stickies = file.stickies.filter((s) => s.kind === kind).sort(readingOrder);
    if (stickies.length === 0) continue;
    lines.push("", `## ${STICKY[kind].plural}`, "");
    for (const s of stickies) lines.push(`- ${oneLine(s.text)}${where(s)}`);
  }

  const areas = file.areas.filter((a) => a.label.trim());
  if (areas.length > 0) {
    lines.push("", "## Areas", "");
    for (const area of areas) {
      const inside = file.stickies.filter((s) => areaOf(s, file.areas) === area).length;
      lines.push(`- ${oneLine(area.label)} (${inside} sticky note${inside === 1 ? "" : "s"})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
