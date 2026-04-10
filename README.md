# Cache Manager — Strapi 5 Plugin

A plug-and-play Strapi 5 plugin that gives editors manual control over cache invalidation directly from the admin UI. It abstracts away the cache implementation — Varnish, Redis proxy APIs, CDN purge APIs, or any HTTP-based cache system can be configured as a provider without touching plugin code.

---

## Features

- **Document Action** — "Purge Cache" in the edit view dropdown and in list-view table row actions. Purges the cache entry for the specific content being edited.
- **Bulk Action** — "Purge Cache (N)" in the list-view bulk action toolbar. Deduplicates paths across all selected entries before purging, so `/news` is only called once even if 20 articles are selected.
- **Settings Dashboard** — Settings > Cache Manager shows all configured providers, their available endpoints, live connection statistics, per-provider "Purge" buttons, a "Purge All Caches" control, and a read-only view of the content type mapping configuration.
- **Provider-agnostic** — Communicates with any HTTP-accessible cache system. All connection details live in `config/plugins.ts`.
- **Environment variable interpolation** — Use `${VAR_NAME}` in any URL or header value. Resolved at request time from `process.env`, so credentials are never hardcoded.
- **Internationalized** — Ships with English and German translations. Additional languages can be added by dropping a JSON file in `admin/src/translations/`.

---

## How It Works

### The Big Picture

```
Strapi Admin UI
  ├── Edit view → Document Action ("Purge Cache")   ─┐
  ├── List view → Bulk Action ("Purge Cache (N)")    ├──▶  Admin API (authenticated)  ──▶  Cache Service  ──▶  Provider HTTP endpoints
  └── Settings → Cache Manager Dashboard            ─┘         /cache-manager/*             (server)            (Varnish, CDN, ...)
```

When an editor triggers a purge:

1. The admin UI calls one of the plugin's server-side routes, authenticated via the Strapi admin JWT.
2. The server fetches the content entry from Strapi's document service to get its field values (slug, etc.).
3. The cache service resolves which frontend URL paths need purging, using the **content type mapping** defined in config.
4. For each resolved path, the service calls the configured **provider endpoints** over HTTP — for example, Varnish's `/varnish-purge` and `/varnish-ban` endpoints.
5. Results are aggregated and returned. The `success` field reflects whether at least one provider call succeeded.

### Content Type → URL Path Resolution

The `contentTypeMapping` config tells the plugin how to translate a Strapi content type entry into frontend URL paths. For example:

```
api::post.post + { slug: "my-post" }
  → pathPattern "/blog/{slug}"  →  "/blog/my-post"
  → relatedPaths               →  "/blog", "/"
  → purge: ["/blog/my-post", "/blog", "/"]
```

The `{fieldName}` placeholder in `pathPattern` is replaced with the actual value of that field from the entry. Any top-level entry field can be used — `{slug}`, `{locale}`, `{id}`, etc.

Content types with `purgeAllOnChange: true` skip path resolution entirely and ban everything (useful for global content like headers, footers, and navigation menus).

### Varnish Purge Strategy: Purge + Ban

For each path, the plugin calls **both** the `purge` and `ban` endpoints on providers that have them configured:

- **`purge`** (`POST /varnish-purge` with `X-Purge-URL`): Removes the exact cached object immediately. Fast and precise.
- **`ban`** (`POST /varnish-ban` with `X-Ban-URL`): Adds a ban expression to Varnish's ban list. Invalidates any object whose URL matches the pattern, including any grace-period or stale objects that `purge` might miss.

Together they provide thorough cache invalidation: `purge` handles the immediately cached object, `ban` handles any lingering stale variants.

---

## Setup

### Prerequisites

- Strapi 5.x
- Node 22+

### Step 1 — Install

```bash
npm install @leancoders/strapi-plugin-cache-manager
# or
pnpm add @leancoders/strapi-plugin-cache-manager
# or
yarn add @leancoders/strapi-plugin-cache-manager
```

### Step 2 — Configure the plugin

In `config/plugins.ts`:

```typescript
export default ({ env }) => ({
  'cache-manager': {
    enabled: true,
    config: {
      providers: [
        {
          name: 'Varnish',
          type: 'http',
          endpoints: {
            purge: {
              url: '${VARNISH_URL}/varnish-purge',
              method: 'POST',
              headers: { 'X-Purge-Token': '${VARNISH_PURGE_TOKEN}' },
              pathParam: 'X-Purge-URL',
              pathLocation: 'header',
            },
            ban: {
              url: '${VARNISH_URL}/varnish-ban',
              method: 'POST',
              headers: { 'X-Purge-Token': '${VARNISH_PURGE_TOKEN}' },
              pathParam: 'X-Ban-URL',
              pathLocation: 'header',
            },
            purgeAll: {
              url: '${VARNISH_URL}/varnish-ban',
              method: 'POST',
              headers: {
                'X-Purge-Token': '${VARNISH_PURGE_TOKEN}',
                'X-Ban-URL': '.',
              },
            },
          },
        },
      ],
      contentTypeMapping: {
        'api::post.post': {
          pathPattern: '/blog/{slug}',
          relatedPaths: ['/blog', '/'],
        },
        'api::page.page': {
          pathPattern: '/{slug}',
        },
        'api::footer.footer': {
          purgeAllOnChange: true,
        },
        'api::tag.tag': {
          relatedPaths: ['/blog'],
        },
      },
    },
  },
});
```

### Step 3 — Set environment variables

```bash
# .env
VARNISH_URL=http://localhost:6081       # local dev (Varnish exposed on port 6081)
VARNISH_PURGE_TOKEN=your-secret-token  # must match the token Varnish is configured with
```

In production (Docker), use `VARNISH_URL=http://varnish` (the container name).

### Step 4 — Start Strapi

```bash
pnpm develop
```

Navigate to **Settings > Cache Manager** to verify providers are showing.

---

## Configuration Reference

### Provider Shape

```typescript
{
  name: string;    // Display name shown in the dashboard
  type: string;    // Informational type tag (e.g. 'http')
  endpoints: {
    purge?: ProviderEndpoint;     // Called for each path on single/bulk purge
    ban?: ProviderEndpoint;       // Called for each path on single/bulk purge (Varnish ban list)
    purgeAll?: ProviderEndpoint;  // Called when "Purge All" is triggered
    stats?: ProviderEndpoint;     // Called on dashboard load to show statistics
  };
}
```

All endpoints are optional. A provider with only `purgeAll` is valid. A provider with only `stats` is valid.

### Endpoint Shape

```typescript
{
  url: string;                         // Base URL — supports ${VAR_NAME} interpolation
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;    // Extra headers — supports ${VAR_NAME} interpolation
  params?: Record<string, string>;     // Static query parameters added to every request
  pathParam?: string;                  // Name of the param or header that receives the path value
  pathLocation?: 'query' | 'header';  // Where the path value is sent (default: 'query')
}
```

### Path Delivery: `pathParam` and `pathLocation`

When purging a specific URL (e.g. `/news/my-article`), the plugin needs to tell the cache system which URL to purge. Different systems expect this in different places:

**Via query parameter** (`pathLocation: 'query'`, the default):

```
GET http://my-cache/purge?path=/news/my-article
                    ^^^^
                    pathParam: 'path'
```

**Via HTTP header** (`pathLocation: 'header'`):

```
POST http://varnish/varnish-purge
X-Purge-URL: /news/my-article
^^^^^^^^^^^^^^^^^
pathParam: 'X-Purge-URL'
```

### Content Type Mapping

```typescript
contentTypeMapping: {
  'api::post.post': {
    pathPattern: '/blog/{slug}',     // {fieldName} replaced with entry field value
    relatedPaths: ['/blog', '/'],    // Additional paths purged alongside the entry path
  },
  'api::footer.footer': {
    purgeAllOnChange: true,          // Triggers purgeAll instead of path-based purge
  },
  'api::tag.tag': {
    relatedPaths: ['/blog'],         // No pathPattern — only related paths are purged
  },
}
```

| Field              | Type       | Description                                                        |
| ------------------ | ---------- | ------------------------------------------------------------------ |
| `pathPattern`      | `string`   | URL pattern — `{fieldName}` is replaced with `entry[fieldName]`    |
| `relatedPaths`     | `string[]` | Extra paths purged alongside the entry path (e.g. listing pages)   |
| `purgeAllOnChange` | `boolean`  | When `true`, triggers a full cache purge instead of specific paths |

**Field substitution examples:**

```
pathPattern: '/blog/{slug}'          + entry.slug = 'my-post'    →  '/blog/my-post'
pathPattern: '/{locale}/blog/{slug}' + entry.locale = 'en', entry.slug = 'my-post'  →  '/en/blog/my-post'
pathPattern: '/products/{slug}'      + entry.slug = 'my-product' →  '/products/my-product'
```

Any top-level field on the Strapi entry can be used as a placeholder.

### Environment Variable Interpolation

Use `${VAR_NAME}` anywhere in a URL, header value, or param value:

```typescript
url: '${VARNISH_URL}/varnish-purge'          // resolved at request time
headers: { 'X-Purge-Token': '${VARNISH_PURGE_TOKEN}' }
```

Resolution happens at **request time** (not at startup), so:

- Credentials are never exposed in the config or the database
- The admin UI never receives URLs or header values (only provider names and endpoint keys)
- A missing `${VAR_NAME}` resolves to an empty string (does not crash Strapi)

---

## Provider Configuration Examples

### Varnish

Varnish accepts purge and ban via custom HTTP endpoints defined in `default.vcl`:

```typescript
{
  name: 'Varnish',
  type: 'http',
  endpoints: {
    purge: {
      url: '${VARNISH_URL}/varnish-purge',
      method: 'POST',
      headers: { 'X-Purge-Token': '${VARNISH_PURGE_TOKEN}' },
      pathParam: 'X-Purge-URL',
      pathLocation: 'header',
    },
    ban: {
      url: '${VARNISH_URL}/varnish-ban',
      method: 'POST',
      headers: { 'X-Purge-Token': '${VARNISH_PURGE_TOKEN}' },
      pathParam: 'X-Ban-URL',
      pathLocation: 'header',
    },
    purgeAll: {
      url: '${VARNISH_URL}/varnish-ban',
      method: 'POST',
      headers: {
        'X-Purge-Token': '${VARNISH_PURGE_TOKEN}',
        'X-Ban-URL': '.',   // regex '.' matches every URL
      },
    },
  },
}
```

**Required env vars:** `VARNISH_URL`, `VARNISH_PURGE_TOKEN`

**How it works:** The VCL checks `X-Purge-Token` on every purge/ban request. If it matches, the operation proceeds; otherwise Varnish returns 403. The `purgeAll` endpoint bans everything by sending `X-Ban-URL: .` (regex that matches all URLs).

### Redis (via HTTP proxy endpoint)

Redis has no native HTTP API, so you expose a small endpoint in your frontend app (Next.js, Astro, Express, etc.) that handles Redis operations and call it from the plugin.

**Example frontend endpoint** (`/api/cache`):

```
GET  /api/cache?action=clear-path&path=/blog/my-post  → deletes the Redis key for that path
GET  /api/cache?action=stats                           → returns key counts / memory usage
DELETE /api/cache                                      → flushes all cached keys
```

**Plugin config:**

```typescript
{
  name: 'Redis Cache',
  type: 'http',
  endpoints: {
    purge: {
      url: '${FRONTEND_URL}/api/cache',
      method: 'GET',
      headers: { Authorization: 'Bearer ${CACHE_API_TOKEN}' },
      params: { action: 'clear-path' },
      pathParam: 'path',
      pathLocation: 'query',   // sends path as ?path=/blog/my-post
    },
    purgeAll: {
      url: '${FRONTEND_URL}/api/cache',
      method: 'DELETE',
      headers: { Authorization: 'Bearer ${CACHE_API_TOKEN}' },
    },
    stats: {
      url: '${FRONTEND_URL}/api/cache',
      method: 'GET',
      headers: { Authorization: 'Bearer ${CACHE_API_TOKEN}' },
      params: { action: 'stats' },
    },
  },
}
```

**Required env vars:** `FRONTEND_URL`, `CACHE_API_TOKEN`

**How it works:** The plugin calls your frontend's HTTP endpoint for each cache operation. The endpoint translates the request into the appropriate Redis command (`DEL` for a specific key, `FLUSHDB` for purge-all, etc.). The `Authorization` header prevents unauthorized cache clears.

### CDN (Cloudflare example)

```typescript
{
  name: 'Cloudflare',
  type: 'http',
  endpoints: {
    purgeAll: {
      url: 'https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ${CF_API_TOKEN}' },
    },
  },
}
```

> **Note:** Cloudflare's purge API requires a JSON body (`{ "purge_everything": true }`). The current plugin version does not send request bodies. Per-URL purge is not yet supported for APIs that require body payloads. See [Extending the Plugin](#extending-the-plugin).

### Multiple Providers

All providers are called for every operation:

```typescript
providers: [
  { name: 'Varnish', type: 'http', endpoints: { purge: {...}, ban: {...}, purgeAll: {...} } },
  { name: 'Redis Cache', type: 'http', endpoints: { purge: {...}, purgeAll: {...}, stats: {...} } },
]
```

Purging one post calls Varnish's `purge` + `ban` for each path, and in parallel calls the Redis endpoint's `purge` for each path — both caches are invalidated in a single editor action.

---

## Admin API Routes

All routes are served under Strapi's admin API prefix and require a valid admin JWT token (`admin::isAuthenticatedAdmin` policy). They are not accessible from the public Strapi REST/GraphQL API.

| Method | Path                                  | Body / Query                        | Description                                                              |
| ------ | ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/cache-manager/providers`            | —                                   | List providers (name, type, endpoint keys only — no URLs or credentials) |
| GET    | `/cache-manager/stats`                | `?provider=Name` (optional)         | Fetch stats from providers that have a `stats` endpoint                  |
| GET    | `/cache-manager/content-type-mapping` | —                                   | Return the full content type mapping config                              |
| POST   | `/cache-manager/purge-entry`          | `{ contentTypeUid, documentId }`    | Purge cache for one entry                                                |
| POST   | `/cache-manager/purge-bulk`           | `{ contentTypeUid, documentIds[] }` | Purge cache for multiple entries (paths deduplicated)                    |
| POST   | `/cache-manager/purge-all`            | `{ provider? }` (optional)          | Purge all caches (optionally scoped to one provider)                     |

### Response Shape

Every purge route returns:

```json
{
  "success": true,
  "results": [
    {
      "provider": "Varnish",
      "endpoint": "purge",
      "success": true,
      "status": 200,
      "message": "purge succeeded on Varnish",
      "details": null
    },
    {
      "provider": "Varnish",
      "endpoint": "ban",
      "success": true,
      "status": 200,
      "message": "ban succeeded on Varnish",
      "details": null
    }
  ]
}
```

`success` at the top level is `true` when at least one result succeeded and there is at least one result. `details` contains the parsed JSON response body from the cache provider (if any).

**Failure example** (wrong token):

```json
{
  "success": false,
  "results": [
    {
      "provider": "Varnish",
      "endpoint": "purge",
      "success": false,
      "status": 403,
      "message": "purge failed on Varnish: HTTP 403",
      "details": null
    }
  ]
}
```

**Failure example** (network error):

```json
{
  "success": false,
  "results": [
    {
      "provider": "Varnish",
      "endpoint": "purge",
      "success": false,
      "message": "purge failed on Varnish: fetch failed",
      "details": null
    }
  ]
}
```

---

## Plugin File Structure

```
cache-manager/
├── package.json                   strapi plugin package (kind: plugin)
├── README.md
├── ARCHITECTURE.md
│
├── admin/
│   ├── custom.d.ts                ambient type declarations
│   ├── tsconfig.json
│   ├── tsconfig.build.json
│   └── src/
│       ├── index.tsx              plugin registration: document action, bulk action, settings link
│       ├── pluginId.ts            PLUGIN_ID constant: 'cache-manager'
│       ├── api.ts                 authenticated fetch wrappers (getFetchClient)
│       ├── components/
│       │   ├── Initializer.tsx    marks plugin as ready after registration
│       │   └── PluginIcon.tsx     trash icon used in actions
│       ├── pages/
│       │   └── Settings.tsx       dashboard: providers table, stats, purge-all dialog
│       ├── translations/
│       │   ├── en.json            English strings
│       │   └── de.json            German strings
│       └── utils/
│           └── getTranslation.ts  prefixes translation keys with 'cache-manager.'
│
└── server/
    ├── tsconfig.json
    ├── tsconfig.build.json
    └── src/
        ├── index.ts               server entry: wires config, bootstrap, controllers, routes, services
        ├── register.ts            (empty — no custom fields)
        ├── bootstrap.ts           logs configured provider names on startup
        ├── destroy.ts             (empty — no cleanup needed)
        ├── config/
        │   └── index.ts           default config (providers: [], contentTypeMapping: {}) + validator
        ├── controllers/
        │   ├── index.ts
        │   └── cache-controller.ts  validates input, fetches entries, delegates to service
        ├── routes/
        │   ├── index.ts           declares route group as type 'admin'
        │   └── admin-api.ts       6 route definitions with isAuthenticatedAdmin policy
        ├── services/
        │   ├── index.ts
        │   └── cache-service.ts   core logic: env var resolution, path resolution, HTTP execution
        ├── content-types/
        │   └── index.ts           (empty — no custom content types)
        ├── middlewares/
        │   └── index.ts           (empty)
        └── policies/
            └── index.ts           (empty — uses built-in admin policy)
```

---

## Translations

Translation keys follow this naming convention:

| Key prefix                          | Where used                   |
| ----------------------------------- | ---------------------------- |
| `cache-manager.settings.*`          | Settings dashboard page      |
| `cache-manager.action.purge.*`      | Single-entry document action |
| `cache-manager.action.purge-bulk.*` | Bulk action                  |

To add a new language, create `admin/src/translations/{locale}.json` following the same key structure as `en.json`. The `registerTrads` function in `index.tsx` discovers it automatically via dynamic import.

---

## Extending the Plugin

### Adding request bodies

Some APIs (e.g. Cloudflare) require a JSON body. To support this:

1. Add `body?: Record<string, unknown>` to the `ProviderEndpoint` interface in `cache-service.ts`.
2. In `executeEndpoint`, pass `body: endpoint.body ? JSON.stringify(endpoint.body) : undefined` to the `fetch()` call.
3. In `plugins.ts`, configure the endpoint with a `body` field.

### Adding a custom provider type

All providers currently use the `'http'` type. To add a provider that communicates differently (e.g. via native Redis commands):

1. Add a type guard in `executeEndpoint` that checks `provider.type`.
2. Implement the custom logic path for the new type.
3. The `ProviderConfig.type` field can remain freeform — it's informational only.

### Lifecycle hook integration (automatic purge on publish)

The plugin is currently **manual-only** — editors trigger purges. To add automatic purging when content is published:

1. In `server/src/bootstrap.ts`, register lifecycle hooks using `strapi.db.lifecycles.subscribe`.
2. In the `afterUpdate`/`afterPublish` handlers, call `strapi.plugin('cache-manager').service('cache-service').purgeEntry(uid, entry)`.
3. This would make cache invalidation transparent to editors.

---

## Troubleshooting

**Plugin doesn't appear in Settings:**

- Check `enabled: true` in `config/plugins.ts`
- Verify the package is installed: `npm ls @leancoders/strapi-plugin-cache-manager`
- Look for `[cache-manager]` messages in Strapi startup logs

**"fetch failed" on purge:**

- The cache provider isn't running or isn't reachable at the configured URL
- In local dev: start Docker (`docker compose up -d`) and verify your cache service is up
- Test the endpoint directly, e.g.: `curl -X POST http://localhost:6081/varnish-purge -H "X-Purge-Token: your-token" -H "X-Purge-URL: /"`

**HTTP 403 on purge:**

- `VARNISH_PURGE_TOKEN` in your `.env` doesn't match the token your cache provider expects
- Restart the container after changing the token: `docker compose up -d --force-recreate varnish`

**"Invalid URL" on purge:**

- `VARNISH_URL` (or whichever URL env var you're using) is not set in your `.env`
- The `${VAR_NAME}` interpolation resolves to an empty string, making `new URL('')` throw
- Set it to the correct address, e.g. `http://localhost:6081` (local dev) or the container name in production

**Document action not showing in edit view:**

- The action hides itself when `documentId` or `document` is null (e.g. when creating a new entry before first save)
- Check browser console for JavaScript errors
- Verify the content-manager plugin loads before cache-manager

**Bulk action not showing:**

- Select at least one entry in the list view — the action only appears in the bulk selection toolbar
