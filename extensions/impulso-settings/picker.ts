// Searchable picker overlay for `config` features whose value list is large
// or dynamic — e.g. the pi-btw side-thread model, drawn from the live model
// registry. Built on @earendil-works/pi-tui's SelectList, which handles
// up/down/enter/esc and row rendering; this wrapper adds typed-character
// filtering (printable chars append to the filter, Backspace deletes) and a
// bordered fullscreen layout that matches the impulso settings page.
//
// Opened as a *nested* ctx.ui.custom overlay from ImpulsoSettingsView's
// activate() — the impulso page stays mounted underneath, so when the picker
// closes the settings list re-renders with the new value. pi supports stacked
// overlays (pi-btw's own menus do the same), so no need to close the page.
//
// Resolves to the chosen value string, "" if the blank/default row was
// chosen (meaning "remove the key from the config file"), or undefined if
// the user cancelled (Esc/Ctrl+C).

import {
  SelectList,
  type SelectItem,
  type SelectListTheme,
  type Component,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

/** Minimal slice of ctx.ui we need to mount the overlay. */
interface UiLike {
  custom<T>(
    factory: (
      tui: unknown,
      theme: Theme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => Component,
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
}

export interface PickerOptions {
  title: string;
  items: SelectItem[];
  /** Currently-configured value (highlighted as "current" in the list). */
  current?: string;
  /** If set, a leading row with value "" that clears the config key. */
  blankLabel?: string;
}

/** Open a searchable picker as a nested overlay. */
export function openConfigPicker(ui: UiLike, options: PickerOptions): Promise<string | undefined> {
  const items: SelectItem[] = [];
  if (options.blankLabel) items.push({ value: "", label: options.blankLabel });
  for (const it of options.items) {
    if (it.value === "") continue; // avoid colliding with the blank row
    items.push({
      value: it.value,
      label: it.label,
      description: it.value === options.current ? "current" : it.description,
    });
  }
  return ui.custom<string | undefined>(
    (_tui, theme: Theme, _kb, done: (r: string | undefined) => void) =>
      new ConfigPickerView(theme, items, options.title, done),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        row: 0,
        col: 0,
        margin: 0,
      },
    },
  );
}

class ConfigPickerView implements Component {
  private readonly theme: Theme;
  private readonly title: string;
  private readonly onDone: (r: string | undefined) => void;
  private readonly list: SelectList;
  private filter = "";

  constructor(
    theme: Theme,
    items: SelectItem[],
    title: string,
    onDone: (r: string | undefined) => void,
  ) {
    this.theme = theme;
    this.title = title;
    this.onDone = onDone;
    const maxVisible = Math.max(6, (process.stdout.rows || 40) - 10);
    this.list = new SelectList(items, maxVisible, pickerTheme(theme));
    this.list.onSelect = (item: SelectItem) => this.onDone(item.value);
    this.list.onCancel = () => this.onDone(undefined);
  }

  invalidate(): void {
    // Stateless render — nothing to cache.
  }

  handleInput(data: string): void {
    // Backspace (DEL/^H): drop last filter char.
    if (data === "\x7f" || data === "\b") {
      if (this.filter.length > 0) {
        this.filter = this.filter.slice(0, -1);
        this.list.setFilter(this.filter);
      }
      return;
    }
    // Printable ASCII: append to the filter.
    if (data.length === 1 && data >= " " && data <= "~") {
      this.filter += data;
      this.list.setFilter(this.filter);
      return;
    }
    // Arrows / Enter / Esc / Ctrl+C delegate to SelectList.
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const lines: string[] = [];
    lines.push(topBorder(width, this.title));
    const prompt = `Filter: ${this.filter || ""}`;
    lines.push(padRow(this.theme.fg("dim", truncateToWidth(prompt, inner, "")), width));
    lines.push(divider(width));
    const rows = this.list.render(inner);
    for (const r of rows) lines.push(padRow(r, width));
    lines.push(divider(width));
    lines.push(
      padRow(
        this.theme.fg("dim", " type to filter · ↑↓ select · Enter confirm · Esc cancel"),
        width,
      ),
    );
    lines.push(bottomBorder(width));
    return lines;
  }
}

function pickerTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("dim", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("dim", t),
  };
}

function topBorder(width: number, title: string): string {
  return `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 5))}┐`;
}
function bottomBorder(width: number): string {
  return `└${"─".repeat(width - 2)}┘`;
}
function divider(width: number): string {
  return `├${"─".repeat(width - 2)}┤`;
}
function padRow(content: string, width: number): string {
  const inner = width - 2;
  const padding = Math.max(0, inner - visibleWidth(content));
  return `│${content}${" ".repeat(padding)}│`;
}
