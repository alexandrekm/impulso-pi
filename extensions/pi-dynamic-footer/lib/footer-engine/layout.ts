import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { LayoutAssembler } from "./types.js";

// Single-line layout: all info segments share one line, ordered so the most
// glanceable values are leftmost and overflow truncates the less-critical
// right side. Quota usage bars are wide and only appear with /login creds, so
// they get their own line when present (the bar is a different kind of
// display and would crowd the single line off-screen).
export const defaultAssembler: LayoutAssembler = (segments, width, theme) => {
  const sep = " " + theme.fg("dim", "│") + " ";

  const line = [
    segments["turnCount"],
    segments["modelThink"],
    segments["tps"],
    segments["contextUsage"],
    segments["tokens"],
    segments["reasoning"],
    segments["cache"],
    segments["cacheWrite"],
    segments["cost"],
    segments["runtime"],
    segments["pwd"],
    segments["git"],
    segments["prStatus"],
    segments["ciStatus"],
  ]
    .filter(Boolean)
    .join(sep);

  const bars = segments["usageBars"] || "";
  const hasBars = visibleWidth(bars) > 0;

  const padded =
    visibleWidth(line) < width ? line + " ".repeat(width - visibleWidth(line)) : line;
  const main = visibleWidth(line) > width ? truncateToWidth(line, width) : padded;

  if (!hasBars) return [main];
  return [main, truncateToWidth(bars, width)];
};
