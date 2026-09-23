// The Event Model canvas's save queue (src/ui/ModelsPane.tsx):
// overlapping PUTs last-write-wins through reconcileModel, and a save that
// escapes a data-repo switch writes the old model into the new folder — where
// absorb() creates it wholesale, since the file is not there yet. Jobs
// serialize, each snapshots the file when it runs, and flush seals the canvas
// so nothing of its can reach the folder that comes next.

import { describe, expect, test } from "bun:test";
import { createPromiseQueue } from "@specdriven/client";

describe("createPromiseQueue", () => {
  test("a later model save waits for the earlier PUT and sends the latest file", async () => {
    const q = createPromiseQueue();
    let current = "A";
    const disk: string[] = [];
    const hold = Promise.withResolvers<void>();

    const first = q.run(async () => {
      const sent = current;
      await hold.promise;
      disk.push(sent);
    });
    await Promise.resolve();
    current = "B";
    const second = q.run(async () => {
      disk.push(current);
    });
    hold.resolve();
    await first;
    await second;
    expect(disk).toEqual(["A", "B"]);
  });

  test("flush waits until a save that started after it was called has landed", async () => {
    const q = createPromiseQueue();
    let current = "A";
    let disk = "";
    const hold = Promise.withResolvers<void>();

    void q.run(async () => {
      const sent = current;
      await hold.promise;
      disk = sent;
    });
    await Promise.resolve();
    current = "B";
    const flush = (async () => {
      await q.run(async () => {
        disk = current;
      });
      await q.idle();
    })();
    hold.resolve();
    await flush;
    expect(disk).toBe("B");
  });
});

/**
 * ModelCanvas's save/flush, close enough to catch what the pane gets wrong:
 * the queue, the "unchanged since the server confirmed it" guard, the seal,
 * and the unmount save that fires whether or not the pane was flushed. Each
 * PUT records the data folder it reached, which is the whole question —
 * a PUT that lands in the new folder is the bug.
 */
function canvas(put: (file: string) => Promise<string>) {
  const queue = createPromiseQueue();
  let fileRef: string | null = null;
  let savedRef: string | null = null;
  let closed = false;

  const save = async (): Promise<void> => {
    if (closed) return;
    await queue.run(async () => {
      const sent = fileRef;
      if (closed || !sent || sent === savedRef) return;
      try {
        const confirmed = await put(sent);
        savedRef = confirmed;
        // Only when nothing was typed while the PUT was out: otherwise the
        // newer edit stays, and stays dirty.
        if (fileRef === sent) fileRef = confirmed;
      } catch {
        // The pane toasts and moves on; the file stays dirty.
      }
    });
  };

  return {
    /** A gesture on the canvas. */
    edit(next: string) {
      fileRef = next;
    },
    save,
    /** What the app awaits before switching data repo. */
    async flush(): Promise<void> {
      try {
        for (let pass = 0; pass < 5; pass++) {
          await save();
          await queue.idle();
          if (!fileRef || fileRef === savedRef) break;
        }
      } finally {
        closed = true;
      }
    },
    /** The pane leaving: React runs this whenever it commits the unmount. */
    unmount() {
      void save();
    },
    idle: () => queue.idle(),
  };
}

describe("the canvas's parting save", () => {
  test("an edit made while the flush PUT is out still lands in the old folder", async () => {
    let folder = "OLD";
    const disk: string[] = [];
    const hold = Promise.withResolvers<void>();
    let first = true;

    const c = canvas(async (file) => {
      if (first) {
        first = false;
        await hold.promise;
      }
      disk.push(`${folder}:${file}`);
      return file;
    });

    c.edit("v1");
    const flushed = c.flush();
    await Promise.resolve();
    c.edit("v2"); // the user drags a card while the PUT is in flight
    hold.resolve();
    await flushed;

    // Both versions reached the folder they were drawn in, and the flush
    // did not return until they had.
    expect(disk).toEqual(["OLD:v1", "OLD:v2"]);

    folder = "NEW";
    c.unmount();
    await c.idle();
    expect(disk).toEqual(["OLD:v1", "OLD:v2"]);
  });

  test("the unmount save after a flush cannot write into the new folder", async () => {
    // The regression: flush drained the queue, an edit arrived mid-PUT, and
    // the unmount save re-armed behind the flush — landing in whichever
    // folder the switch had moved on to.
    let folder = "OLD";
    const disk: string[] = [];
    const c = canvas(async (file) => {
      disk.push(`${folder}:${file}`);
      return file;
    });

    c.edit("v1");
    await c.flush();
    // The switch happens: the server's dataDir is now the new folder, and
    // only now does React commit the unmount.
    folder = "NEW";
    c.edit("v2");
    c.unmount();
    await c.idle();

    expect(disk).toEqual(["OLD:v1"]);
    expect(disk.some((w) => w.startsWith("NEW:"))).toBe(false);
  });

  test("a sealed canvas ignores a late autosave tick too", async () => {
    let folder = "OLD";
    const disk: string[] = [];
    const c = canvas(async (file) => {
      disk.push(`${folder}:${file}`);
      return file;
    });

    c.edit("v1");
    await c.flush();
    folder = "NEW";
    c.edit("v2");
    await c.save(); // the SAVE_DELAY_MS timer, fired after the switch
    await c.idle();

    expect(disk).toEqual(["OLD:v1"]);
  });

  test("a flush with nothing unsaved sends no PUT at all", async () => {
    const disk: string[] = [];
    const c = canvas(async (file) => {
      disk.push(file);
      return file;
    });

    await c.flush();
    c.unmount();
    await c.idle();
    expect(disk).toEqual([]);
  });

  test("a PUT that keeps failing seals the pane instead of retrying forever", async () => {
    // The folder is switching either way. A canvas left unsealed by a failed
    // save would write into the new one on unmount, and a flush that looped
    // until the file went clean would never let the switch proceed.
    let folder = "OLD";
    let attempts = 0;
    const disk: string[] = [];
    const c = canvas(async (file) => {
      attempts += 1;
      if (folder === "OLD") throw new Error("network");
      disk.push(`${folder}:${file}`);
      return file;
    });

    c.edit("v1");
    await c.flush(); // resolves rather than hanging or throwing
    expect(attempts).toBe(5); // bounded, not unbounded

    folder = "NEW";
    c.unmount();
    await c.idle();
    expect(disk).toEqual([]);
  });
});
