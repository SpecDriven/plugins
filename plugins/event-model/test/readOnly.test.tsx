// The read-only site (specs.specdriven.app, the app's src/server/readOnlyMode.ts):
// the Event Models are listed and shown, never changed — the sidebar offers
// no New model, Import or Delete, and the inspector's fields are disabled
// while the feature link still opens.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyModelFile } from "../src/model/types";
import { addSlice, setSliceLink } from "../src/ui/mutations";
import { Inspector } from "../src/ui/Inspector";
import { ModelsSidebar } from "../src/ui/ModelsPane";

const noop = () => {};
const ask = async () => null;
const sure = async () => false;

const sidebar = (readOnly: boolean) =>
  renderToStaticMarkup(
    <ModelsSidebar
      active={null}
      prompt={ask}
      confirm={sure}
      onNavigate={noop}
      onCopyLink={noop}
      onClosed={noop}
      readOnly={readOnly}
    />,
  );

test("read-only, the sidebar offers no New model or Import", () => {
  expect(sidebar(false)).toContain("+ New model");
  expect(sidebar(false)).toContain('aria-label="Import"');
  expect(sidebar(true)).not.toContain("+ New model");
  expect(sidebar(true)).not.toContain('aria-label="Import"');
});

test("read-only, the inspector shows a slice with its fields disabled and its feature link live", () => {
  const made = addSlice(emptyModelFile("Cart"), "Add item");
  const file = setSliceLink(made.file, made.id, "specs/cart.feature.md");
  const inspector = (readOnly: boolean) =>
    renderToStaticMarkup(
      <Inspector
        file={file}
        selection={{ kind: "slice", id: made.id }}
        features={[]}
        onChange={noop}
        onDeselect={noop}
        onOpenFeature={noop}
        onGenerateFeature={noop}
        prompt={ask}
        confirm={sure}
        readOnly={readOnly}
      />,
    );
  expect(inspector(false)).not.toContain("<fieldset");
  const shown = inspector(true);
  expect(shown).toContain('<fieldset class="em-readonly" disabled=""');
  expect(shown).toContain("Add item");
  expect(shown).toContain('aria-label="Open the feature"');
  expect(renderToStaticMarkup(<Inspector {...{ file, selection: null, features: [], onChange: noop, onDeselect: noop, onOpenFeature: noop, onGenerateFeature: noop, prompt: ask, confirm: sure, readOnly: true }} />)).toContain("to see it");
});
