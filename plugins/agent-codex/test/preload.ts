// Runs before every test file (bunfig.toml): the app's own preload — a
// pinned PATH, no log files — and settings folders of the run's own, so a
// mounted plugin never reads the developer's ~/.specdriven or spawns
// anything on their behalf — and a Codex home of the run's own, so the
// sign-in is never read off the developer's ~/.codex.

import "@specdriven/app/tests/helpers/preload";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SPECDRIVEN_ROOT = mkdtempSync(join(tmpdir(), "specdriven-agent-codex-root-"));
process.env.SPECDRIVEN_HOME = mkdtempSync(join(tmpdir(), "specdriven-agent-codex-home-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "specdriven-agent-codex-codexhome-"));
