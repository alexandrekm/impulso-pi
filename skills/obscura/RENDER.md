# Rendering: screenshots, PDFs, screencasts

Rendering is native (CSS layout/paint engine, no Chromium) and included in the release binaries. Covers block/inline/flex/grid/table/float/positioning/overflow/transform/text/image/SVG/canvas/background/border/animation paths — long-tail CSS and platform font rasterization can differ from Chromium.

## Screenshot of a single page (CLI)

```bash
obscura fetch https://example.com --screenshot page.png   # short form: -s page.png
```

- One URL per invocation; PNG output.
- An omitted `--wait` uses adaptive settling (up to 5s cap) — the *settled* page is captured. An explicit `--wait N` is a fixed delay of N seconds.
- `--timeout N` bounds navigation separately (seconds, default 30).
- `--wait-until load|domcontentloaded|networkidle0` — use `networkidle0` for JS/SPA pages.
- `--selector <css>` waits for a selector before capture.

## Capture a lower section / bottom of the page

The CLI captures the viewport; scroll first with `--eval`, then screenshot:

```bash
obscura fetch https://example.com \
  --eval "window.scrollTo(0, document.documentElement.scrollHeight)" \
  --screenshot bottom.png
```

## Full-page screenshot + precise viewport (CDP)

CLI screenshot is viewport-sized. For full-page, custom viewports, or many captures in one session, use `obscura serve` + Puppeteer:

```javascript
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser" });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto("https://example.com", { waitUntil: "load" });
await page.screenshot({ path: "page.png", fullPage: true });
await browser.disconnect();
```

Details on `serve`, Playwright, and raw CDP: `skill://obscura/CDP.md`.

## PDF export

```bash
obscura serve --port 9222   # then via CDP/Puppeteer:
```
```javascript
await page.pdf({ path: "page.pdf", format: "A4", printBackground: true });
```

Supports paper dimensions, margins, landscape, scale, backgrounds, page ranges. **Raster-backed**: no selectable text, no outlines/headers/footers, no complete CSS paged-media.

## Screencast (live page frames)

Raw CDP only (MCP doesn't stream): `Page.startScreencast` / `Page.stopScreencast`, driven by page activity (not a fixed frame rate). A screencast client **must acknowledge every `Page.screencastFrame`** with `Page.screencastFrameAck`.
