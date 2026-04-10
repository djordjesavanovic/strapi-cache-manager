import type { Core } from '@strapi/strapi';

// --- Types ---

export interface ProviderEndpoint {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  pathParam?: string;
  pathLocation?: 'query' | 'header';
}

export interface ProviderConfig {
  name: string;
  type: string;
  endpoints: {
    purge?: ProviderEndpoint;
    ban?: ProviderEndpoint;
    purgeAll?: ProviderEndpoint;
    invalidateByTag?: ProviderEndpoint;
    stats?: ProviderEndpoint;
  };
}

export interface ContentTypeMappingEntry {
  pathPattern?: string;
  relatedPaths?: string[];
  purgeAllOnChange?: boolean;
  tags?: string[];
}

export interface PurgeResult {
  provider: string;
  endpoint: string;
  success: boolean;
  status?: number;
  message: string;
  details?: unknown;
}

export interface StatsResult {
  provider: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ProviderSummary {
  name: string;
  type: string;
  endpoints: string[];
}

// --- Helpers ---

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });
}

function resolveObjectEnvVars(obj: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    resolved[key] = resolveEnvVars(value);
  }
  return resolved;
}

// --- Service ---

const cacheService = ({ strapi }: { strapi: Core.Strapi }) => {
  function getProviders(): ProviderConfig[] {
    return strapi.plugin('cache-manager').config('providers') as ProviderConfig[];
  }

  function getContentTypeMapping(): Record<string, ContentTypeMappingEntry> {
    return strapi.plugin('cache-manager').config('contentTypeMapping') as Record<
      string,
      ContentTypeMappingEntry
    >;
  }

  function getProviderSummary(): ProviderSummary[] {
    return getProviders().map((p) => ({
      name: p.name,
      type: p.type,
      endpoints: Object.keys(p.endpoints),
    }));
  }

  function resolvePaths(contentTypeUid: string, entry: Record<string, unknown>): string[] {
    const mapping = getContentTypeMapping();
    const config = mapping[contentTypeUid];

    if (!config) {
      return [];
    }

    const paths: string[] = [];

    if (config.pathPattern) {
      const resolvedPath = config.pathPattern.replace(/\{([^}]+)\}/g, (_, field) =>
        String(entry[field] || '')
      );
      if (resolvedPath) {
        paths.push(resolvedPath);
      }
    }

    if (config.relatedPaths) {
      paths.push(...config.relatedPaths);
    }

    return [...new Set(paths)];
  }

  function resolveTagPatterns(contentTypeUid: string, entry: Record<string, unknown>): string[] {
    const mapping = getContentTypeMapping();
    const config = mapping[contentTypeUid];
    if (!config?.tags || config.tags.length === 0) return [];

    return config.tags
      .map((tag) => tag.replace(/\{([^}]+)\}/g, (_, field) => String(entry[field] || '')))
      .filter(Boolean);
  }

  async function executeEndpoint(
    provider: ProviderConfig,
    endpointName: keyof ProviderConfig['endpoints'],
    extraParams?: Record<string, string>,
    bodyOverride?: Record<string, unknown>
  ): Promise<PurgeResult> {
    const endpoint = provider.endpoints[endpointName];

    if (!endpoint) {
      return {
        provider: provider.name,
        endpoint: endpointName,
        success: false,
        message: `Endpoint "${endpointName}" not configured for provider "${provider.name}"`,
      };
    }

    try {
      const url = resolveEnvVars(endpoint.url);
      const headers: Record<string, string> = endpoint.headers
        ? resolveObjectEnvVars(endpoint.headers)
        : {};
      const params: Record<string, string> = endpoint.params
        ? resolveObjectEnvVars(endpoint.params)
        : {};

      // Apply extra params (e.g. path from purgeEntry)
      if (extraParams) {
        const pathParam = endpoint.pathParam;
        const pathLocation = endpoint.pathLocation || 'query';

        if (pathParam && extraParams.path) {
          if (pathLocation === 'header') {
            headers[pathParam] = extraParams.path;
          } else {
            params[pathParam] = extraParams.path;
          }
        }
      }

      // Build URL with query params
      const urlObj = new URL(url);
      for (const [key, value] of Object.entries(params)) {
        urlObj.searchParams.set(key, value);
      }

      const body = bodyOverride ?? endpoint.body;

      const response = await fetch(urlObj.toString(), {
        method: endpoint.method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      const responseData = await response.json().catch(() => null);

      return {
        provider: provider.name,
        endpoint: endpointName,
        success: response.ok,
        status: response.status,
        message: response.ok
          ? `${endpointName} succeeded on ${provider.name}`
          : `${endpointName} failed on ${provider.name}: HTTP ${response.status}`,
        details: responseData,
      };
    } catch (error) {
      return {
        provider: provider.name,
        endpoint: endpointName,
        success: false,
        message: `${endpointName} failed on ${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function purgeEntry(
    contentTypeUid: string,
    entry: Record<string, unknown>
  ): Promise<PurgeResult[]> {
    const mapping = getContentTypeMapping();
    const config = mapping[contentTypeUid];
    const providers = getProviders();
    const results: PurgeResult[] = [];

    // If this content type should purge all caches on change
    if (config?.purgeAllOnChange) {
      return purgeAll();
    }

    const paths = resolvePaths(contentTypeUid, entry);

    if (paths.length === 0) {
      strapi.log.info(`[cache-manager] No paths to purge for ${contentTypeUid}`);
      return [
        {
          provider: 'all',
          endpoint: 'purge',
          success: true,
          message: `No cache paths configured for content type ${contentTypeUid}`,
        },
      ];
    }

    for (const provider of providers) {
      for (const path of paths) {
        // Call purge endpoint
        if (provider.endpoints.purge) {
          results.push(await executeEndpoint(provider, 'purge', { path }));
        }
        // Also call ban endpoint if available (for Varnish-style providers)
        if (provider.endpoints.ban) {
          results.push(await executeEndpoint(provider, 'ban', { path }));
        }
      }
    }

    // Call invalidateByTag once per provider if tags are configured
    const resolvedTags = resolveTagPatterns(contentTypeUid, entry);
    if (resolvedTags.length > 0) {
      for (const provider of providers) {
        if (provider.endpoints.invalidateByTag) {
          const tagBody = { ...provider.endpoints.invalidateByTag.body, tags: resolvedTags };
          results.push(await executeEndpoint(provider, 'invalidateByTag', undefined, tagBody));
        }
      }
    }

    return results;
  }

  async function purgeBulk(
    contentTypeUid: string,
    entries: Record<string, unknown>[]
  ): Promise<PurgeResult[]> {
    const mapping = getContentTypeMapping();
    const config = mapping[contentTypeUid];

    // If this content type should purge all caches on change
    if (config?.purgeAllOnChange) {
      return purgeAll();
    }

    // Collect and deduplicate all paths
    const allPaths = new Set<string>();
    for (const entry of entries) {
      const paths = resolvePaths(contentTypeUid, entry);
      paths.forEach((p) => allPaths.add(p));
    }

    const providers = getProviders();
    const results: PurgeResult[] = [];

    for (const provider of providers) {
      for (const path of allPaths) {
        if (provider.endpoints.purge) {
          results.push(await executeEndpoint(provider, 'purge', { path }));
        }
        if (provider.endpoints.ban) {
          results.push(await executeEndpoint(provider, 'ban', { path }));
        }
      }
    }

    // Collect and deduplicate tags across all entries, then call invalidateByTag once per provider
    const allTags = new Set<string>();
    for (const entry of entries) {
      resolveTagPatterns(contentTypeUid, entry).forEach((t) => allTags.add(t));
    }

    if (allTags.size > 0) {
      const resolvedTags = [...allTags];
      for (const provider of providers) {
        if (provider.endpoints.invalidateByTag) {
          const tagBody = { ...provider.endpoints.invalidateByTag.body, tags: resolvedTags };
          results.push(await executeEndpoint(provider, 'invalidateByTag', undefined, tagBody));
        }
      }
    }

    return results;
  }

  async function purgeAll(providerName?: string): Promise<PurgeResult[]> {
    const providers = getProviders();
    const targets = providerName ? providers.filter((p) => p.name === providerName) : providers;

    const results: PurgeResult[] = [];

    for (const provider of targets) {
      if (provider.endpoints.purgeAll) {
        results.push(await executeEndpoint(provider, 'purgeAll'));
      }
    }

    return results;
  }

  async function getStats(providerName?: string): Promise<StatsResult[]> {
    const providers = getProviders();
    const targets = providerName ? providers.filter((p) => p.name === providerName) : providers;

    const results: StatsResult[] = [];

    for (const provider of targets) {
      if (provider.endpoints.stats) {
        const result = await executeEndpoint(provider, 'stats');
        results.push({
          provider: provider.name,
          success: result.success,
          data: result.details,
          error: result.success ? undefined : result.message,
        });
      }
    }

    return results;
  }

  return {
    getProviders,
    getContentTypeMapping,
    getProviderSummary,
    resolvePaths,
    resolveTagPatterns,
    executeEndpoint,
    purgeEntry,
    purgeBulk,
    purgeAll,
    getStats,
  };
};

export default cacheService;
