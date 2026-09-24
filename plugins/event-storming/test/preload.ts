// Runs before every test file (bunfig.toml): the app's own preload — a
// pinned PATH, no log files — and settings folders of the run's own, so a
// mounted plugin never reads the developer's ~/.specdriven or reaches their
// data repo, which the running app pushes to GitHub.

import "@specdriven/app/tests/helpers/preload";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SPECDRIVEN_ROOT = mkdtempSync(join(tmpdir(), "specdriven-storming-root-"));
process.env.SPECDRIVEN_HOME = mkdtempSync(join(tmpdir(), "specdriven-storming-home-"));
