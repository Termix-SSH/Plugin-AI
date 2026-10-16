import {
  planContext,
  type ContextPlan,
  type ModelOverrides,
} from "./context-window.js";
import { getAdapter } from "./providers/registry.js";
import type { ModelInfo, ProviderConfig } from "./providers/types.js";

/**
 * What providers report about their models, kept for a while so a chat does
 * not ask before every message. A provider that cannot answer in time is
 * asked again sooner, and editing a provider forgets what it said.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5_000;

interface Entry {
  expires: number;
  info: Promise<ModelInfo>;
}

/** The config with every request cut short after `ms`. */
function withTimeout(config: ProviderConfig, ms: number): ProviderConfig {
  return {
    ...config,
    fetch: (url, init) => {
      const timeout = AbortSignal.timeout(ms);
      return config.fetch(url, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    },
  };
}

export function createModelInfoCache(
  options: { ttlMs?: number; retryMs?: number; timeoutMs?: number } = {},
  now: () => number = Date.now,
) {
  const ttl = options.ttlMs ?? TTL_MS;
  const retry = options.retryMs ?? RETRY_MS;
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  const entries = new Map<string, Entry>();
  const keyOf = (providerId: number, model: string) =>
    `${providerId}\n${model}`;

  return {
    /** Never fails: a provider that does not answer reported nothing. */
    get(
      providerId: number,
      config: ProviderConfig,
      model: string,
    ): Promise<ModelInfo> {
      const key = keyOf(providerId, model);
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return hit.info;

      const entry: Entry = { expires: now() + ttl, info: Promise.resolve({}) };
      entry.info = getAdapter(config.providerType)
        .describeModel(withTimeout(config, timeout), model)
        .catch((): ModelInfo => ({}))
        .then((info) => {
          if (!info.contextWindow) entry.expires = now() + retry;
          return info;
        });
      entries.set(key, entry);
      return entry.info;
    },

    invalidate(providerId: number): void {
      for (const key of entries.keys()) {
        if (key.startsWith(`${providerId}\n`)) entries.delete(key);
      }
    },
  };
}

export type ModelInfoCache = ReturnType<typeof createModelInfoCache>;

/** The plan for one of a provider's models, with what the provider said. */
export async function contextPlanFor(
  cache: ModelInfoCache,
  provider: { id: number; modelOverrides: ModelOverrides },
  config: ProviderConfig,
  model: string,
): Promise<ContextPlan & { reported: ModelInfo }> {
  const info = await cache.get(provider.id, config, model);
  return {
    ...planContext({
      model,
      overrides: provider.modelOverrides,
      info,
      adapter: getAdapter(config.providerType),
    }),
    reported: info,
  };
}
