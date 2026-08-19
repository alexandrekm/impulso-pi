// /impulso — impulso-pi feature settings page.
//
// An OMP-style tabbed settings UI built on @earendil-works/pi-tui. Each
// row is a feature (npm/git package, local extension, or a pi built-in
// setting) grouped under section headings within tabs. Enter/Space toggles
// or cycles the value; ←/→ (or Tab) switch tabs; Esc closes.
//
// Toggles persist immediately to settings.json (packages/autoload, pi
// keys) and <configDir>/impulso-settings.json (local-extension manifest).
// A "modified" hint reminds you to run /reload to apply changes — pi reads
// settings.json + re-loads extensions on reload, so that's the apply step.

import {
  type Component,
  getKeybindings,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  TABS,
  featureValues,
  featuresForTab,
  getFeatureState,
  setFeatureState,
  type Feature,
} from "./features.ts";
import { makeImpulsoEditorFactory } from "./editor.ts";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };

interface Row {
  kind: "heading" | "feature";
  label: string;
  feature?: Feature;
}

/**
 * Fullscreen tabbed settings view. Returned from ctx.ui.custom()'s factory;
 * pi renders render(width) and routes handleInput(data) to it.
 */
export class ImpulsoSettingsView implements Component {
  private readonly theme: Theme;
  private readonly onDone: () => void;
  private readonly launch: ((command: string) => void) | undefined;
  private tabIndex = 0;
  private cursor = 0;
  private scrollOffset = 0;
  private dirty = false;
  private rows: Row[] = [];

  constructor(theme: Theme, onDone: () => void, launch?: (command: string) => void) {
    this.theme = theme;
    this.onDone = onDone;
    this.launch = launch;
    this.rebuildRows();
  }

  invalidate(): void {
    // No cached render state — everything is recomputed in render().
  }

  // ── rows ──────────────────────────────────────────────────────────────

  private rebuildRows(): void {
    const tabId = TABS[this.tabIndex].id;
    const features = featuresForTab(tabId);
    const rows: Row[] = [];
    let lastGroup = "";
    for (const f of features) {
      if (f.group !== lastGroup) {
        rows.push({ kind: "heading", label: f.group });
        lastGroup = f.group;
      }
      rows.push({ kind: "feature", label: f.label, feature: f });
    }
    this.rows = rows;
    // Keep cursor on a feature row if possible.
    if (this.cursor >= this.rows.length) this.cursor = this.lastFeatureIndex() ?? 0;
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
    this.clampScroll();
  }

  private lastFeatureIndex(): number | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].kind === "feature") return i;
    }
    return undefined;
  }

  private activeFeature(): Feature | undefined {
    const row = this.rows[this.cursor];
    return row?.kind === "feature" ? row.feature : undefined;
  }

  private moveCursor(delta: number): void {
    if (this.rows.length === 0) return;
    this.cursor = (this.cursor + delta + this.rows.length) % this.rows.length;
    this.clampScroll();
  }

  private clampScroll(): void {
    const maxVisible = this.contentRowCount();
    if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
    if (this.cursor >= this.scrollOffset + maxVisible)
      this.scrollOffset = this.cursor - maxVisible + 1;
  }

  // ── input ─────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.onDone();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      this.moveCursor(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.moveCursor(1);
      return;
    }
    if (kb.matches(data, "tui.select.confirm") || data === " ") {
      this.activate();
      return;
    }
    // ←/→ switch tabs; Tab cycles to the next tab.
    if (data === "\x1b[D" || data === "\x1b[C" || data === "\t") {
      const dir = data === "\x1b[D" ? -1 : 1;
      this.tabIndex = (this.tabIndex + dir + TABS.length) % TABS.length;
      this.cursor = 0;
      this.scrollOffset = 0;
      this.rebuildRows();
      return;
    }
  }

  private activate(): void {
    const f = this.activeFeature();
    if (!f) return; // heading rows are inert
    if (f.kind === "launch") {
      // Close our overlay, then dispatch the package's own config command.
      // pi.sendUserMessage with expandPromptTemplates routes "/cmd" through
      // the extension-command path (agent-session._tryExecuteExtensionCommand),
      // opening the package's UI (e.g. the vision-handoff model picker).
      const cmd = f.command;
      this.onDone();
      if (cmd) this.launch?.(cmd);
      return;
    }
    const values = featureValues(f);
    const current = getFeatureState(f);
    const idx = values.indexOf(current);
    const next = values[(idx + 1) % values.length];
    try {
      setFeatureState(f, next);
      this.dirty = true;
    } catch {
      // Surface via a transient marker; pi will re-render.
      this.dirty = true;
    }
  }

  // ── render ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const inner = Math.max(1, width - 4); // border + 1 pad each side

    const lines: string[] = [];
    lines.push(topBorder(width, "Impulso Settings"));
    lines.push(padRow(this.renderTabStrip(inner), width));
    lines.push(divider(width));

    const contentRows = this.contentRowCount();
    const rendered = this.renderContent(inner, contentRows);
    for (let i = 0; i < contentRows; i++) lines.push(padRow(rendered[i] ?? "", width));

    lines.push(divider(width));
    lines.push(padRow(this.theme.fg("dim", this.footerHint()), width));
    lines.push(bottomBorder(width));
    return lines;
  }

  private contentRowCount(): number {
    const height = Math.max(16, process.stdout.rows || 40);
    // top + tabs + divider + content + divider + hint + bottom = 7 chrome rows.
    return Math.max(4, height - 7);
  }

  private renderTabStrip(inner: number): string {
    const parts: string[] = [];
    for (let i = 0; i < TABS.length; i++) {
      const active = i === this.tabIndex;
      const label = TABS[i].label;
      parts.push(
        active ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.fg("muted", label),
      );
    }
    const joined = parts.join("  ");
    return ` ${truncateToWidth(joined, inner - 1, "")}`;
  }

  private renderContent(inner: number, rowCount: number): string[] {
    const lines: string[] = [];
    const labelCol = Math.min(34, Math.max(12, ...this.rows.map((r) => visibleWidth(r.label))) + 2);
    const end = Math.min(this.rows.length, this.scrollOffset + rowCount);
    for (let i = this.scrollOffset; i < end; i++) {
      const row = this.rows[i];
      const selected = i === this.cursor;
      if (row.kind === "heading") {
        lines.push(this.theme.fg("dim", ` ${this.theme.bold(row.label.toUpperCase())}`));
        continue;
      }
      const f = row.feature!;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const label = truncateToWidth(row.label, labelCol, "");
      const labelText = selected ? this.theme.fg("accent", label) : label;
      const gap = " ".repeat(Math.max(1, labelCol - visibleWidth(label)));
      const value = getFeatureState(f);
      const valueText = this.renderValue(value, selected);
      lines.push(truncateToWidth(`${prefix}${labelText}${gap}${valueText}`, inner, ""));
    }
    // Description for the selected feature.
    const f = this.activeFeature();
    if (f) {
      lines.push("");
      const desc = stripTerminalSequences(f.description);
      const descLines = wrapPlain(desc, inner - 4);
      for (const l of descLines) lines.push(this.theme.fg("dim", `  ${l}`));
    }
    return lines;
  }

  private renderValue(value: string, selected: boolean): string {
    const isOn = value === "on" || (value !== "off" && value !== "");
    const tag = isOn ? "● on" : "○ off";
    // For enum values other than on/off, show the value plainly.
    const text = value === "on" || value === "off" ? tag : value;
    return selected ? this.theme.fg("accent", text) : this.theme.fg(isOn ? "muted" : "dim", text);
  }

  private footerHint(): string {
    const reload = this.dirty ? "  · modified — run /reload to apply" : "";
    return ` ↑↓ move · Enter/Space toggle · ←/→ or Tab switch tabs · Esc close${reload}`;
  }
}

// ── small render helpers ─────────────────────────────────────────────────

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
  const visible = visibleWidth(content);
  const padding = Math.max(0, inner - visible);
  return `│${content}${" ".repeat(padding)}│`;
}

function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w;
      continue;
    }
    if (visibleWidth(line) + 1 + visibleWidth(w) <= width) {
      line += ` ${w}`;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── extension factory ────────────────────────────────────────────────────

export default function (pi: any): void {
  let editorInstalled = false;

  // Dispatch a slash command (e.g. /vision-handoff) after the impulso overlay
  // closes, so a `launch` feature row can open a package's own config UI.
  // pi.sendUserMessage with expandPromptTemplates routes "/cmd" through the
  // extension-command path, opening the package's overlay. Safe when idle.
  const launchCommand = (cmd: string) => {
    try {
      pi.sendUserMessage(cmd, { expandPromptTemplates: true });
    } catch {
      // Non-fatal: the command will be visible in the editor history instead.
    }
  };

  // Install the custom editor once per process so `/settings` opens the
  // impulso page. Re-installed on /reload (module re-loads). Done in
  // session_start because that's the first event with a usable ctx.ui;
  // installing on every session_start would churn the editor on /new etc.
  pi.on("session_start", (_event: any, ctx: any) => {
    if (editorInstalled || !ctx.hasUI || !ctx.ui?.setEditorComponent) return;
    try {
      ctx.ui.setEditorComponent(
        makeImpulsoEditorFactory(ctx.ui, ImpulsoSettingsView, launchCommand),
      );
      editorInstalled = true;
    } catch {
      // If a custom editor can't be installed, `/settings` keeps its pi
      // default and `/impulso` still works — non-fatal.
    }
  });

  pi.registerCommand("impulso", {
    description: "Open the impulso-pi feature settings menu",
    handler: async (_args: string, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("The impulso settings menu needs the TUI.", "error");
        return;
      }
      await ctx.ui.custom(
        (_tui: unknown, theme: Theme, _keybindings: unknown, done: () => void) => {
          return new ImpulsoSettingsView(theme, done, launchCommand);
        },
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
    },
  });
}
