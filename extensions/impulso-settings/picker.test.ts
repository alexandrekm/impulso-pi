import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { openConfigPicker } from "./picker.ts";
import type { Component } from "@earendil-works/pi-tui";

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bold: (t: string) => `*${t}*`,
};

type Picker = {
  handleInput(data: string): void;
  render(width: number): string[];
  title: string;
  list: {
    items: { value: string; label: string; description?: string }[];
    onSelect: (item: { value: string }) => void;
    onCancel: () => void;
    filteredItems: { value: string }[];
  };
  filter: string;
};

function open(options: Parameters<typeof openConfigPicker>[1]) {
  let view: Picker | undefined;
  let doneResult: string | undefined | "unset" = "unset";
  const promise = openConfigPicker(
    {
      custom: async <T>(
        factory: (
          tui: unknown,
          theme: { fg(color: string, text: string): string; bold(text: string): string },
          kb: unknown,
          done: (r: T) => void,
        ) => Component,
      ) => {
        view = factory({}, theme, {}, (r: T) => {
          doneResult = r as string | undefined | "unset";
        }) as unknown as Picker;
        return undefined as T;
      },
    },
    options,
  );
  assert.ok(view);
  return { view: view!, promise, result: () => doneResult };
}

describe("openConfigPicker", () => {
  test("items: blank row first, empty-value items skipped, current marked", () => {
    const { view } = open({
      title: "Pick",
      current: "b",
      blankLabel: "Same as main",
      items: [
        { value: "", label: "colliding-blank" }, // dropped: collides with blank row
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    assert.equal(view.title, "Pick");
    const items = view.list.items;
    assert.deepEqual(
      items.map((i) => i.value),
      ["", "a", "b"],
    );
    assert.equal(items[0]!.label, "Same as main");
    assert.equal(items[2]!.description, "current");
    assert.equal(items[1]!.description, undefined);
  });

  test("selecting an item resolves the picker with its value; cancel → undefined", async () => {
    const { view, result } = open({
      title: "Pick",
      items: [{ value: "x", label: "X" }],
    });
    view.list.onSelect({ value: "x" });
    assert.equal(result(), "x");

    view.list.onCancel();
    assert.equal(result(), undefined);
  });
});

describe("ConfigPickerView.handleInput", () => {
  function make() {
    return open({
      title: "Pick",
      items: [
        { value: "alpha", label: "alpha" },
        { value: "beta", label: "beta" },
        { value: "gamma", label: "gamma" },
      ],
    });
  }

  test("printable chars filter the list; backspace un-filters", () => {
    const { view } = make();
    view.handleInput("a");
    view.handleInput("l");
    assert.equal(view.filter, "al");
    assert.deepEqual(
      view.list.filteredItems.map((i) => i.value),
      ["alpha"],
    );

    view.handleInput("\x7f"); // DEL
    assert.equal(view.filter, "a");
    // SelectList filters by prefix, so "a" still matches only alpha.
    assert.equal(view.list.filteredItems.length, 1);

    view.handleInput("\x7f");
    view.handleInput("\x7f"); // backspace on empty filter: no crash
    assert.equal(view.filter, "");
    assert.equal(view.list.filteredItems.length, 3);
  });

  test("non-printable control sequences delegate to the SelectList", () => {
    const { view } = make();
    view.handleInput("\x1b[A"); // up
    view.handleInput("\x1b[B"); // down
    const selected = (view.list as unknown as { selectedIndex: number }).selectedIndex;
    assert.equal(typeof selected, "number");
  });

  test("render draws borders, filter prompt and hint", () => {
    const { view } = make();
    view.handleInput("q");
    const lines = view.render(60);
    assert.match(lines[0]!, /^┌─ Pick /);
    assert.ok(lines.some((l) => l.includes("Filter: q")));
    assert.ok(lines.some((l) => l.includes("Esc cancel")));
    assert.equal(lines.at(-1), `└${"─".repeat(58)}┘`);
  });
});
