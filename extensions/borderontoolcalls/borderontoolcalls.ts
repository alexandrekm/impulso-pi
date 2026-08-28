// Draws a visible border box around every tool call in the TUI transcript,
// labeled with the tool's name (e.g. `┌─ bash ─┐`), so each tool invocation
// stands out as a discrete framed block amid the assistant's prose.
//
// Pi renders each tool call with ToolExecutionComponent (a Container that,
// depending on the tool's renderShell, either wraps its content in a
// bg-filled Box or lets the tool render its own framing). There is no public
// extension hook to reframe it, so — like border-on-user-messages patches
// UserMessageComponent — we monkey-patch ToolExecutionComponent.prototype
// .render at session_start. The patch calls the original render at a slightly
// narrower width (width - 2, leaving room for left/right `│`), strips the
// leading/trailing blank padding rows (the Spacer the constructor adds, plus
// any Box padding), pads each remaining row to the inner width so the right
// rail lines up, sandwiches the rows between `│` rails, and caps them with a
// `┌─ <toolName> ─┐` top border and a `└──────┘` bottom border. The interior
// keeps its existing bg (toolPendingBg / toolErrorBg / toolSuccessBg) and any
// tool-owned framing, so the box frame reads against the page background while
// the tool body keeps its familiar highlight.
//
// Toggleable from /impulso (feature id `border-on-tool-calls`): disabling
// + /reload restores the original render. Reload-safe via a BASE_KEY marker
// on the patched function, so re-running the factory never double-wraps.
//
// TUI-only: in rpc/json/print modes there is no transcript to reframe.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

const FEATURE_ID = "border-on-tool-calls";

// Marker stored on the patched render fn pointing at the true original render,
// so a reload can unwrap before re-wrapping (never double-patch).
const BASE_KEY = "__impulsoBorderToolCallBase__";

// Below this width the box would have <2 inner columns; fall back to base.
const MIN_BOX_WIDTH = 6;

// The ToolExecutionComponent instance fields we need to read. They are
// private on the class, but accessible at runtime via a structural cast.
interface ToolExecLike {
  toolName: string;
}

type UiRef = { readonly theme: Theme };

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    installPatch(isFeatureEnabled(FEATURE_ID), ctx.ui as UiRef);
  });
}

function installPatch(enabled: boolean, ui: UiRef): void {
  const proto = ToolExecutionComponent.prototype as {
    render: ((width: number) => string[]) & { [BASE_KEY]?: (width: number) => string[] };
  };
  const current = proto.render;
  // If a previous module instance already patched render, unwrap to the true
  // base before deciding what to install. Otherwise `current` is the base.
  const base = current?.[BASE_KEY] ?? current;
  if (!enabled || typeof base !== "function") {
    proto.render = base;
    return;
  }

  const patched = function patchedToolCallRender(this: ToolExecLike, width: number): string[] {
    const theme = ui.theme;
    if (!theme || width < MIN_BOX_WIDTH) return base.call(this, width);

    const inner = width - 2;
    // Render at width - 2 so the bg-filled rows are exactly the inner width
    // of the box; the two `│` rails then bring each row back to `width`.
    const baseLines = base.call(this, width - 2);
    if (baseLines.length === 0) return baseLines;

    // Drop leading/trailing blank rows (the constructor's Spacer, Box
    // padding, the self-shell's leading "", etc.) so the frame hugs content.
    let first = 0;
    while (first < baseLines.length && stripTerminalSequences(baseLines[first]).trim() === "")
      first++;
    let last = baseLines.length - 1;
    while (last > first && stripTerminalSequences(baseLines[last]).trim() === "") last--;
    const content = baseLines.slice(first, last + 1);
    if (content.length === 0) return baseLines;

    const label = ` ${this.toolName ?? ""} `;
    const side = theme.fg("borderAccent", "│");
    const out: string[] = [topBorder(theme, width, label)];
    for (const line of content) {
      // Pad short rows (e.g. inline images that don't fill the width) so
      // the right rail lands at the right edge. Bg-filled rows from the
      // Box are already exactly `inner` wide, so this is a no-op for them.
      const pad = Math.max(0, inner - visibleWidth(line));
      out.push(side + line + " ".repeat(pad) + side);
    }
    out.push(bottomBorder(theme, width));
    return out;
  };

  patched[BASE_KEY] = base;
  proto.render = patched;
}

function topBorder(theme: Theme, width: number, label: string): string {
  const inner = width - 2; // columns between the two corners
  const labelW = visibleWidth(label);
  const border = (s: string) => theme.fg("borderAccent", s);
  if (labelW + 2 > inner) return border(`┌${"─".repeat(inner)}┐`);
  const leftDash = "─".repeat(2);
  const rightDash = "─".repeat(inner - 2 - labelW);
  return border(`┌${leftDash}`) + theme.bold(theme.fg("accent", label)) + border(`${rightDash}┐`);
}

function bottomBorder(theme: Theme, width: number): string {
  const inner = width - 2;
  return theme.fg("borderAccent", `└${"─".repeat(inner)}┘`);
}
