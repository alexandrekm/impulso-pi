// Draws a visible border box around every user message in the TUI transcript,
// so your own messages are easy to spot amid assistant/tool output.
//
// Pi renders user messages with UserMessageComponent (a Container wrapping a
// Box that paints `userMessageBg` behind the markdown). There is no public
// extension hook to reframe it, so — like pi-droid-styling's user-prefix and
// core-message-block patches — we monkey-patch UserMessageComponent.prototype
// .render at session_start. The patch calls the original render at a slightly
// narrower width (width - 2, leaving room for left/right `│`), strips the
// leading/trailing blank padding rows the Box adds, sandwiches the remaining
// bg-filled rows between `│` rails, and caps them with `┌─ You ─┐` /
// `└──────┘`. The interior keeps its existing `userMessageBg`, so the box
// frame reads against the page background while the message body keeps its
// familiar highlight.
//
// Toggleable from /impulso (feature id `border-on-user-messages`): disabling
// + /reload restores the original render. Reload-safe via a BASE_KEY marker
// on the patched function, so re-running the factory never double-wraps.
//
// TUI-only: in rpc/json/print modes there is no transcript to reframe.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";

const FEATURE_ID = "border-on-user-messages";

// Marker stored on the patched render fn pointing at the true original render,
// so a reload can unwrap before re-wrapping (never double-patch).
const BASE_KEY = "__impulsoBorderUserMsgBase__";

// OSC 133 prompt-zone markers. The base render injects these on its first/last
// lines; we strip them from content and re-attach to the box frame so terminal
// shell-integration still sees the zone boundaries.
const OSC133_A = "\x1b]133;A\x07";
const OSC133_B = "\x1b]133;B\x07";
const OSC133_C = "\x1b]133;C\x07";

// Below this width the box would have <2 inner columns; fall back to base.
const MIN_BOX_WIDTH = 6;

const LABEL = " You ";

type UiRef = { readonly theme: Theme };

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    installPatch(isFeatureEnabled(FEATURE_ID), ctx.ui as UiRef);
  });
}

function installPatch(enabled: boolean, ui: UiRef): void {
  const proto = UserMessageComponent.prototype as {
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

  const patched = function patchedUserMessageRender(this: unknown, width: number): string[] {
    const theme = ui.theme;
    if (!theme || width < MIN_BOX_WIDTH) return base.call(this, width);

    // Render at width - 2 so the bg-filled rows are exactly the inner width
    // of the box; the two `│` rails then bring each row back to `width`.
    const baseLines = base.call(this, width - 2);
    if (baseLines.length === 0) return baseLines;

    // Drop the Box's top/bottom padding rows so the frame hugs the text.
    let first = 0;
    while (first < baseLines.length && stripTerminalSequences(baseLines[first]).trim() === "")
      first++;
    let last = baseLines.length - 1;
    while (last > first && stripTerminalSequences(baseLines[last]).trim() === "") last--;
    const content = baseLines.slice(first, last + 1);
    if (content.length === 0) return baseLines;

    const side = theme.fg("borderAccent", "│");
    const out: string[] = [topBorder(theme, width)];
    for (const line of content) {
      // Remove the OSC 133 markers the base put on its boundary lines; we
      // re-attach them to the frame below. Zero visible width, so alignment
      // is unaffected.
      out.push(side + line.replace(/\x1b\]133;[ABC]\x07/g, "") + side);
    }
    out.push(bottomBorder(theme, width));

    out[0] = OSC133_A + out[0];
    out[out.length - 1] = OSC133_B + OSC133_C + out[out.length - 1];
    return out;
  };

  patched[BASE_KEY] = base;
  proto.render = patched;
}

function topBorder(theme: Theme, width: number): string {
  const inner = width - 2; // columns between the two corners
  const labelW = visibleWidth(LABEL);
  const border = (s: string) => theme.fg("borderAccent", s);
  if (labelW + 2 > inner) return border(`┌${"─".repeat(inner)}┐`);
  const leftDash = "─".repeat(2);
  const rightDash = "─".repeat(inner - 2 - labelW);
  return border(`┌${leftDash}`) + theme.bold(theme.fg("accent", LABEL)) + border(`${rightDash}┐`);
}

function bottomBorder(theme: Theme, width: number): string {
  const inner = width - 2;
  return theme.fg("borderAccent", `└${"─".repeat(inner)}┘`);
}
