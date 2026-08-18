// pi-droid-styling's physical-render self-heal writes directly to absolute
// terminal rows after Pi's normal renderer. With Pi 0.84 fullscreen rendering,
// an editor reflow can move the bottom zone between those writes, leaving a
// stale second copy of its status/input/footer rows on screen. Keep Pi's normal
// renderer as the sole owner of terminal painting. Users can explicitly set
// PI_DROID_RENDER_PHYSICAL_SYNC=1 to re-enable the upstream workaround.

if (!process.env.PI_DROID_RENDER_PHYSICAL_SYNC) {
  process.env.PI_DROID_RENDER_PHYSICAL_SYNC = "0";
}

export default function (_pi: any): void {
  // This module intentionally only establishes the environment before the
  // styling extension creates its editor component.
}
