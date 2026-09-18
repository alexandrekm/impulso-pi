// openrouter-cost extension factory — see openrouter-cost.ts for the design.
//
// Wiring: `after_provider_request` paths never touch this file; the flow is
//   after_provider_response (capture x-generation-id for openrouter)
//   → message_end (poll the Generation API, rewrite usage.cost)
//
// Pending ids are keyed by provider (like pi-provider-litellm's cost slot):
// requests from other providers must not feed OpenRouter cost state, and
// interleaved responses within one session replace the slot last-writer-wins
// — the message that follows consumed the most recent response.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { isFeatureEnabled } from "../impulso-settings/feature-flag.ts";
import {
  distributeCost,
  generationIdFromHeaders,
  makeGenerationApi,
  pollGenerationCost,
  readOpenRouterKey,
  type CostedUsage,
  type GenerationApi,
  type PollOptions,
} from "./openrouter-cost.ts";

const FEATURE_ID = "openrouter-cost";
const PROVIDER = "openrouter";
/** The generation record shows up ~2-5s after the response; poll within that budget. */
const POLL_ATTEMPTS = 4;
const POLL_DELAY_MS = 1500;

const CONFIG_DIR =
  process.env.PI_CODING_AGENT_DIR || dirname(dirname(fileURLToPath(import.meta.url)));

/** Wire the capture+rewrite flow onto a pi instance with injectable IO. */
export function wireOpenRouterCost(
  pi: any,
  deps: { api?: GenerationApi; poll?: PollOptions; configDir?: string } = {},
): void {
  const configDir = deps.configDir ?? CONFIG_DIR;
  const pending = new Map<string, string>();
  const poll: PollOptions = deps.poll ?? {
    attempts: POLL_ATTEMPTS,
    delayMs: POLL_DELAY_MS,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  // The API client is built lazily per message: auth.json may appear after
  // the extension loaded (fresh /login), and a missing key disables the flow.
  const apiFor = (): { api: GenerationApi; id: string } | undefined => {
    const id = pending.get(PROVIDER);
    if (!id) return undefined;
    const key = readOpenRouterKey(configDir);
    if (!key) return undefined;
    return { api: deps.api ?? makeGenerationApi(key, fetch), id };
  };

  pi.on("after_provider_response", (event: any, ctx: any) => {
    if (ctx?.model?.provider !== PROVIDER) return;
    if (event?.status !== 200) return; // failed/retried response: keep the old slot
    const id = generationIdFromHeaders(event.headers);
    if (id) pending.set(PROVIDER, id);
    else pending.delete(PROVIDER); // headerless response can't be costed
  });

  pi.on("message_end", async (event: any) => {
    const message = event?.message;
    if (message?.role !== "assistant" || message.provider !== PROVIDER) return;
    const slot = apiFor();
    pending.delete(PROVIDER); // consumed either way; a retry response re-fills it
    if (!slot || !message.usage) return;
    const total = await pollGenerationCost(slot.id, slot.api, poll);
    if (total === null) return; // record never appeared → keep pi's estimate
    const usage = message.usage as CostedUsage & { totalTokens?: number };
    return {
      message: {
        ...message,
        usage: { ...usage, cost: distributeCost(usage, total) },
      },
    };
  });
}

export default function (pi: any): void {
  if (!isFeatureEnabled(FEATURE_ID)) return;
  wireOpenRouterCost(pi);
}
