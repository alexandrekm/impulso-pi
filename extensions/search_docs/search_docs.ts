// search_docs — consult the team's documentation Knowledge Base (AWS Bedrock)
// before reaching for the web.
//
// Strategy:
//   1. Query the Bedrock Knowledge Base via the API Gateway proxy (gateway
//      mode). The gateway holds the IAM permission and signs the SigV4 call
//      server-side; the client only needs KB_GATEWAY_URL + KB_GATEWAY_KEY.
//      The KB id is locked server-side, so it is not configurable here.
//      (Mirrors ~/code/docs/search_kb.py gateway_retrieve().)
//   2. Return the retrieved chunks (score + source URI + text) so the agent
//      LLM can synthesize the answer — no extra model call, no RAG cost.
//   3. If the KB returns no useful results, return a short note telling the
//      agent to fall back to the existing `websearch` tool. This reuses the
//      already-installed @alfonzjanfrithz/pi-websearch providers/keys and
//      avoids duplicating search logic in this extension.
//
// Configuration (environment):
//   KB_GATEWAY_URL  - base URL of the API Gateway proxy (required)
//   KB_GATEWAY_KEY  - x-api-key for the gateway (required)
//   KB_NUM_RESULTS  - default numberOfResults (default: 10)
//   KB_MIN_SCORE    - discard chunks below this score (default: 0.0 = keep all)
//
// When KB_GATEWAY_URL/KEY are not set, the tool still registers (so the LLM
// sees it) but immediately returns a hint to use `websearch`, so a missing
// config never blocks the agent.

// NOTE: `pi` (pi's ExtensionAPI) is typed as `any` to avoid importing the
// full `@earendil-works/pi-coding-agent` types just for the registerTool
// surface, and the tool parameter schema is inlined as a plain JSON Schema
// object (which is all `Type.Object(...)` produces). We DO import the small
// rendering helpers we need for the custom TUI renderer:
//   - `Text` from `@earendil-works/pi-tui` (the Component a renderResult returns)
//   - `keyHint` from `@earendil-works/pi-coding-agent` (keybinding-aware hint)
// These are provided by the pi runtime at load time (via jiti aliases) and are
// also declared as devDependencies here so `npm run typecheck` resolves them in
// CI. A custom `renderResult` is what makes pi collapse this tool's (large)
// output by default and expand it on `app.tools.expand` (ctrl+o); without it
// pi falls back to dumping the entire `content` text, ignoring `expanded`.

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";

const DEFAULT_NUM_RESULTS = 10;
const GATEWAY_TIMEOUT_MS = 60_000;

interface KbRetrievalResult {
  score?: number;
  content?: { text?: string };
  location?: {
    s3Location?: { uri?: string };
    webLocation?: { url?: string };
  };
  metadata?: Record<string, unknown>;
}

interface KbRetrieveResponse {
  retrievalResults?: KbRetrievalResult[];
  // Gateway may surface an error object instead.
  error?: { message?: string; type?: string };
}

function gatewayBase(): string | undefined {
  const url = process.env.KB_GATEWAY_URL;
  return url && url.trim() ? url.replace(/\/+$/, "") : undefined;
}

function gatewayKey(): string | undefined {
  const key = process.env.KB_GATEWAY_KEY;
  return key && key.trim() ? key : undefined;
}

function defaultNumResults(): number {
  const raw = Number.parseInt(process.env.KB_NUM_RESULTS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NUM_RESULTS;
}

function minScore(): number {
  const v = Number.parseFloat(process.env.KB_MIN_SCORE ?? "");
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function sourceUri(r: KbRetrievalResult): string {
  return r.location?.s3Location?.uri ?? r.location?.webLocation?.url ?? "(unknown source)";
}

function fmtScore(score: number | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) return "?";
  return score.toFixed(2);
}

/** Truncate a chunk for the returned context. Long chunks are kept but capped. */
function truncate(text: string, max = 2000): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Format retrieved chunks into a single text block for the LLM. */
function formatChunks(results: KbRetrievalResult[]): string {
  const lines: string[] = [];
  lines.push(
    `Found ${results.length} documentation chunk${results.length === 1 ? "" : "s"} in the Knowledge Base:`,
  );
  lines.push("");
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### ${i + 1}. [score ${fmtScore(r.score)}] ${sourceUri(r)}`);
    lines.push(truncate(r.content?.text ?? "(no text)"));
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** The "nothing useful in the KB" message, nudging the agent to websearch. */
function noKbResultsMessage(query: string): string {
  return [
    `No documentation found in the Knowledge Base for: "${query}".`,
    "Fall back to the `websearch` tool to look this up on the web.",
    "(The KB covers internal/team docs only; for third-party libraries, public web docs, or anything not in the KB, use `websearch`.)",
  ].join("\n");
}

function kbNotConfiguredMessage(): string {
  return [
    "search_docs is not configured (KB_GATEWAY_URL / KB_GATEWAY_KEY not set).",
    "Use the `websearch` tool to look this up on the web instead.",
  ].join("\n");
}

async function gatewayRetrieve(
  query: string,
  numResults: number,
  signal: AbortSignal | undefined,
  onUpdate?: (u: { content: Array<{ type: "text"; text: string }> }) => void,
): Promise<KbRetrieveResponse> {
  const base = gatewayBase()!;
  const key = gatewayKey()!;
  const url = `${base}/retrieve`;

  onUpdate?.({ content: [{ type: "text", text: `Searching Knowledge Base: "${query}"…` }] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        retrievalQuery: { text: query },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: numResults } },
      }),
      signal: controller.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Gateway error ${resp.status}: ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as KbRetrieveResponse;
    } catch {
      throw new Error(`Gateway returned non-JSON response: ${text.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Tool parameter schema, as a plain JSON Schema object (equivalent to the
// `Type.Object({ query: Type.String(...), numResults: Type.Optional(Type.Number(...)) })`
// shape from typebox — typebox just emits JSON Schema).
const SearchDocsParams = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "What to look up in the documentation Knowledge Base. Prefer library/framework names, API names, error messages, or feature keywords — the same phrasing you'd use for docs search.",
    },
    numResults: {
      type: "number",
      description: `Maximum number of documentation chunks to retrieve (default: ${DEFAULT_NUM_RESULTS}).`,
    },
  },
  required: ["query"],
} as const;

interface SearchDocsInput {
  query: string;
  numResults?: number;
}

/** Shape of the `details` object returned by search_docs execute(). */
interface SearchDocsResultDetails {
  source?: "kb";
  configured?: boolean;
  query?: string;
  numRequested?: number;
  numReturned?: number;
  minScore?: number;
  fallBackTo?: string;
  error?: string;
}

/** Minimal structural type for the `theme` arg passed to renderResult. */
interface RenderTheme {
  fg(color: string, text: string): string;
}

// `pi` is pi's ExtensionAPI. Typed as `any` to avoid importing the
// `@earendil-works/pi-coding-agent` types (not in this repo's node_modules).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isFeatureEnabled(id: string): boolean {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
    const raw = readFileSync(join(dir, "impulso-settings.json"), "utf8");
    return !((JSON.parse(raw).disabled ?? []) as string[]).includes(id);
  } catch {
    return true;
  }
}

export default function searchDocsExtension(pi: any) {
  if (!isFeatureEnabled("search_docs")) return;
  const year = new Date().getFullYear();

  pi.registerTool({
    name: "search_docs",
    label: "Search Docs",
    description: [
      "Search the team's internal documentation Knowledge Base (AWS Bedrock) for library docs, API references, runbooks, and other internal/team documentation.",
      "Use this tool FIRST whenever the user asks about a library, API, framework, or any documentation — it returns curated, up-to-date internal docs that may not exist on the public web.",
      "",
      `The current year is ${year}. When querying about versions or recent changes, include the year if relevant.`,
      "",
      "If the KB has no useful results, the tool will tell you to fall back to the `websearch` tool. Prefer this tool over `websearch` for documentation.",
    ].join("\n"),
    promptSnippet:
      "Search the internal documentation Knowledge Base (Bedrock) for library/API/team docs",
    promptGuidelines: [
      "Use search_docs FIRST for any library, API, framework, or documentation question — it queries the team's internal docs Knowledge Base.",
      "If search_docs returns no results (or says to fall back), use the websearch tool for public/third-party documentation.",
    ],
    parameters: SearchDocsParams,

    // Custom TUI renderer: pi collapses tool output by default and toggles it
    // with `app.tools.expand` (ctrl+o), but ONLY for tools that define a
    // renderResult. Without one, pi dumps the whole `content` text and ignores
    // `expanded` — which is why search_docs used to print every retrieved chunk.
    // Here we show a one-line summary when collapsed and the full chunks when
    // expanded. See pi docs: extensions.md "renderResult" / "Best Practices".
    renderResult(
      result: {
        content?: Array<{ type: string; text?: string }>;
        details?: SearchDocsResultDetails;
      },
      { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
      theme: RenderTheme,
      context: { isError?: boolean },
    ) {
      if (isPartial) {
        return new Text(theme.fg("muted", "Searching Knowledge Base…"), 0, 0);
      }

      const d = result.details ?? {};

      // Not configured: nudge to websearch.
      if (d.configured === false) {
        return new Text(theme.fg("dim", "search_docs not configured — use websearch"), 0, 0);
      }

      // Gateway failure.
      if (context.isError || d.error) {
        return new Text(
          theme.fg("error", `search_docs failed: ${d.error ?? "unknown error"} — use websearch`),
          0,
          0,
        );
      }

      const n = d.numReturned ?? 0;
      const q = d.query ?? "";

      // No useful results: steer to websearch.
      if (n === 0) {
        return new Text(theme.fg("dim", `No KB results for "${q}" — use websearch`), 0, 0);
      }

      const head =
        theme.fg("success", `✓ ${n} doc chunk${n === 1 ? "" : "s"} from KB`) +
        (q ? theme.fg("muted", `  “${q}”`) : "");

      // Collapsed: compact one-liner with an expand hint (keyHint respects the
      // user's keymap, e.g. ctrl+o).
      if (!expanded) {
        return new Text(
          `${head}  ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
          0,
          0,
        );
      }

      // Expanded: the full formatted chunks, already assembled in content[0].text.
      const body = result.content?.[0]?.text ?? "";
      return new Text(theme.fg("toolOutput", body), 0, 0);
    },

    async execute(
      _toolCallId: string,
      params: SearchDocsInput,
      signal: AbortSignal | undefined,
      onUpdate?: (u: { content: Array<{ type: "text"; text: string }> }) => void,
      _ctx?: unknown,
    ) {
      const base = gatewayBase();
      const key = gatewayKey();

      // Not configured: don't block the agent, just point it at websearch.
      if (!base || !key) {
        return {
          content: [{ type: "text", text: kbNotConfiguredMessage() }],
          details: { source: "kb", configured: false, query: params.query },
          isError: false,
        };
      }

      const numResults = Math.max(1, Math.min(50, params.numResults ?? defaultNumResults()));
      const cutoff = minScore();

      try {
        const resp = await gatewayRetrieve(params.query, numResults, signal, onUpdate);

        if (resp.error) {
          throw new Error(`Gateway error: ${resp.error.message ?? resp.error.type ?? "unknown"}`);
        }

        let results = resp.retrievalResults ?? [];
        if (cutoff > 0) {
          results = results.filter((r) => (r.score ?? 0) >= cutoff);
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: noKbResultsMessage(params.query) }],
            details: {
              source: "kb",
              configured: true,
              query: params.query,
              numRequested: numResults,
              numReturned: 0,
              fallBackTo: "websearch",
            },
            isError: false,
          };
        }

        return {
          content: [{ type: "text", text: formatChunks(results) }],
          details: {
            source: "kb",
            configured: true,
            query: params.query,
            numRequested: numResults,
            numReturned: results.length,
            minScore: cutoff,
          },
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Gateway failure: surface the error but still steer the agent to websearch.
        return {
          content: [
            {
              type: "text",
              text: [
                `search_docs failed to query the Knowledge Base: ${msg}`,
                "Use the `websearch` tool to look this up on the web instead.",
              ].join("\n"),
            },
          ],
          details: {
            source: "kb",
            configured: true,
            query: params.query,
            error: msg,
            fallBackTo: "websearch",
          },
          isError: true,
        };
      }
    },
  });
}
