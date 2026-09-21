# Automation: CDP server, Puppeteer/Playwright, MCP

Obscura implements the Chrome DevTools Protocol — a drop-in replacement for headless Chrome. Use it for anything interactive: click, fill, type, login flows, multi-step sessions, many screenshots in one session.

## Start the CDP server

```bash
obscura serve --port 9222                     # WebSocket CDP server
obscura serve --port 9222 --stealth           # + anti-detection & tracker blocking
obscura serve --port 9222 --allow-private-network   # to test against local dev servers
```

`serve` flags: `--port` (default 9222), `--proxy <url>`, `--stealth`, `--workers N`, `--font-dir <dir>` (repeatable), `--obey-robots`.

## Puppeteer

```bash
npm install puppeteer-core
```
```javascript
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser" });
const page = await browser.newPage();
await page.goto("https://news.ycombinator.com");
const stories = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".titleline > a")).map(a => ({ title: a.textContent, url: a.href }))
);
await browser.disconnect();   // leaves the server running
```

## Playwright

```bash
npm install playwright-core
```
```javascript
import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP({ endpointURL: "ws://127.0.0.1:9222" });
const page = await browser.newContext().then(ctx => ctx.newPage());
await page.goto("https://en.wikipedia.org/wiki/Web_scraping");
console.log(await page.title());
await browser.close();
```

## Form submission & login

Obscura handles the POST, follows redirects, and maintains cookies:

```javascript
await page.goto("https://quotes.toscrape.com/login");
await page.evaluate(() => {
  document.querySelector("#username").value = "admin";
  document.querySelector("#password").value = "admin";
  document.querySelector("form").submit();
});
```

## Raw CDP

Implemented domains: Target, Page (navigate, captureScreenshot, start/stopScreencast, printToPDF), Runtime, DOM, Network (cookies/headers/UA), Fetch (live interception), IO (chunked body streaming), Storage, Input (mouse/key), and `LP.getMarkdown` (DOM→Markdown).

- Screencast: acknowledge every `Page.screencastFrame` with `Page.screencastFrameAck`.
- Large downloads: `Fetch.takeResponseBodyAsStream` + `IO.read`/`IO.close` (bodies over the cache limit — `OBSCURA_NETWORK_BODY_BUFFER_BYTES`, default 2 MiB — are not retained; raise the limit when streaming large downloads).

## MCP server

`obscura mcp` (stdio) or `obscura mcp --http --port 8080` (HTTP endpoint `http://127.0.0.1:8080/mcp`). Tools: `browser_navigate`, `browser_snapshot`, `browser_screenshot` (PNG), `browser_pdf`, `browser_click`, `browser_fill`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_evaluate`, `browser_wait_for`, `browser_network_requests`, `browser_console_messages`, `browser_close`.

Note: pi sessions normally drive obscura through the CLI/CDP (this skill); the MCP server exists for MCP clients. Navigate first, then snapshot/interact; refresh the snapshot after navigation, clicks, scrolling, or a framework rerender — element references may have changed. MCP does not stream screencast frames; use CDP for that.
