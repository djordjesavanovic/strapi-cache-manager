# Cache Manager — Architecture & Technical Reference

This document provides an in-depth look at the plugin's internals, data flows, Strapi integration points, security model, and guidance for adapting it to other projects.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Server-Side Architecture](#server-side-architecture)
   - [Lifecycle](#lifecycle)
   - [Configuration & Validation](#configuration--validation)
   - [Cache Service Internals](#cache-service-internals)
   - [Controller & Routing](#controller--routing)
3. [Admin-Side Architecture](#admin-side-architecture)
   - [Content Manager Integration](#content-manager-integration)
   - [Settings Dashboard](#settings-dashboard)
   - [API Client Layer](#api-client-layer)
4. [Request Flows](#request-flows)
   - [Single Entry Purge](#flow-1-single-entry-purge)
   - [Bulk Entry Purge](#flow-2-bulk-entry-purge)
   - [Purge All from Dashboard](#flow-3-purge-all-from-dashboard)
   - [Statistics Loading](#flow-4-statistics-loading)
5. [Provider System](#provider-system)
   - [Endpoint Schema](#endpoint-schema)
   - [Environment Variable Interpolation](#environment-variable-interpolation)
   - [Path Delivery Mechanisms](#path-delivery-mechanisms)
   - [Provider Examples Walkthrough](#provider-examples-walkthrough)
6. [Content Type Mapping In Depth](#content-type-mapping-in-depth)
   - [Path Resolution Algorithm](#path-resolution-algorithm)
   - [Field Substitution](#field-substitution)
   - [Edge Cases](#edge-cases)
7. [Security Model](#security-model)
8. [Error Handling](#error-handling)
9. [Internationalization](#internationalization)
10. [Adapting to Other Projects](#adapting-to-other-projects)
11. [Troubleshooting](#troubleshooting)
12. [Future Considerations](#future-considerations)

---

## Design Principles

1. **Zero coupling to cache implementations** — The plugin has no direct dependency on Redis, Varnish, or any cache library. All communication happens through configurable HTTP endpoints.

2. **Config-driven, not code-driven** — Switching from Redis to Varnish (or adding a CDN layer) requires only a config change in `plugins.ts`. No plugin code needs to change.

3. **Convention over configuration** — Sensible defaults (`pathLocation: 'query'`, `slugField: 'slug'`) mean minimal config for common cases.

4. **All three interaction points share one backend** — The document action, bulk action, and dashboard all call the same service methods, ensuring consistent behavior.

---

## Server-Side Architecture

### Lifecycle

The plugin participates in Strapi's standard lifecycle:

```
register()    — Empty (no custom fields or types to register)
      |
bootstrap()   — Reads provider config, logs provider names to stdout
      |         Warns if no providers are configured
      |
[runtime]     — Controller handles admin API requests
      |         Service executes HTTP calls to providers
      |
destroy()     — Empty (no cleanup needed; HTTP connections are stateless)
```

The bootstrap log output helps operators verify configuration at startup:

```
[cache-manager] Initialized with 2 provider(s): HTML Cache, Strapi Data Cache
```

or:

```
[cache-manager] No cache providers configured. Plugin will be inactive.
```

### Configuration & Validation

**File:** `server/src/config/index.ts`

The config system has two layers:

1. **Defaults** — `providers: []` and `contentTypeMapping: {}` ensure the plugin can load even without explicit config.

2. **Validator** — Runs at Strapi startup. Fails fast with descriptive errors if:
   - `providers` is not an array
   - Any provider is missing `name` (string), `type` (string), or `endpoints` (object)
   - `contentTypeMapping` is not an object (if provided)

Config values are read at runtime (not cached in the service) via:

```typescript
strapi.plugin('cache-manager').config('providers');
strapi.plugin('cache-manager').config('contentTypeMapping');
```

This means config changes in `plugins.ts` take effect on the next Strapi restart without any service-level caching issues.

### Cache Service Internals

**File:** `server/src/services/cache-service.ts`

The service is the core of the plugin. It is a factory function that receives `{ strapi }` and returns a plain object of methods (not a class). This follows Strapi's standard service factory pattern.

#### Exported Types

All interfaces are exported so TypeScript consumers can reference them:

| Type                      | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `ProviderEndpoint`        | Shape of a single endpoint (url, method, headers, params, pathParam, pathLocation) |
| `ProviderConfig`          | A full provider with name, type, and endpoints map                                 |
| `ContentTypeMappingEntry` | Path pattern, related paths, purgeAll flag                                         |
| `PurgeResult`             | Result of a single purge/ban/purgeAll operation                                    |
| `StatsResult`             | Result of a stats fetch for one provider                                           |
| `ProviderSummary`         | Lightweight view of a provider for the admin UI                                    |

#### Method Reference

| Method                                                  | Sync/Async | Description                                                                                                            |
| ------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `getProviders()`                                        | sync       | Returns the full `ProviderConfig[]` from plugin config                                                                 |
| `getContentTypeMapping()`                               | sync       | Returns the full mapping object from plugin config                                                                     |
| `getProviderSummary()`                                  | sync       | Maps providers to `{ name, type, endpoints: string[] }` for the admin UI (strips sensitive data like URLs and headers) |
| `resolvePaths(uid, entry)`                              | sync       | Resolves a content type UID + entry into an array of URL paths to purge                                                |
| `executeEndpoint(provider, endpointName, extraParams?)` | async      | The generic HTTP execution engine — resolves env vars, applies path params, makes the fetch call                       |
| `purgeEntry(uid, entry)`                                | async      | Orchestrates purging for one entry across all providers                                                                |
| `purgeBulk(uid, entries)`                               | async      | Collects and deduplicates paths from multiple entries, then purges                                                     |
| `purgeAll(providerName?)`                               | async      | Calls `purgeAll` endpoint on all (or one specific) provider                                                            |
| `getStats(providerName?)`                               | async      | Calls `stats` endpoint on providers that have one                                                                      |

#### `executeEndpoint` — The HTTP Engine

This is the most important method. It handles all communication with external cache systems.

**Step-by-step:**

```
1. Look up endpoint config:  provider.endpoints[endpointName]
   If not found → return failure result (no HTTP call made)

2. Resolve environment variables:
   url     = resolveEnvVars(endpoint.url)        // "${CLIENT_URL}" → "http://web:4321"
   headers = resolveObjectEnvVars(endpoint.headers)
   params  = resolveObjectEnvVars(endpoint.params)

3. Apply path parameter (if extraParams.path is provided):
   Read endpoint.pathParam and endpoint.pathLocation
   If pathLocation === 'header':
     headers[pathParam] = extraParams.path        // e.g. X-Purge-URL: /news/my-article
   Else (pathLocation === 'query', the default):
     params[pathParam] = extraParams.path          // e.g. ?path=/news/my-article

4. Build final URL:
   const urlObj = new URL(url)
   for each (key, value) in params:
     urlObj.searchParams.set(key, value)

5. Execute HTTP request:
   fetch(urlObj.toString(), {
     method: endpoint.method,
     headers: { 'Content-Type': 'application/json', ...headers }
   })

6. Parse response:
   Try to parse body as JSON (fall back to null on failure)

7. Return PurgeResult:
   { provider, endpoint, success: response.ok, status, message, details }
```

**Error handling:** Network errors, DNS failures, and timeouts are caught and returned as a `PurgeResult` with `success: false`. The service never throws — all errors are captured in the result objects.

### Controller & Routing

**File:** `server/src/controllers/cache-controller.ts`

The controller is a thin layer that:

1. Extracts parameters from `ctx.query` or `ctx.request.body`
2. Validates required fields (returns `ctx.badRequest` if missing)
3. Looks up entries via `strapi.documents()` API (Strapi 5's document service)
4. Delegates to the cache service
5. Logs results to `strapi.log`
6. Returns JSON responses

**File:** `server/src/routes/admin-api.ts`

All 6 routes are registered under the `admin-api` key with `type: 'admin'`. This means:

- They are served under Strapi's admin API prefix (typically `/cache-manager/...`)
- They require a valid admin JWT token
- They are protected by the `admin::isAuthenticatedAdmin` policy

| Route                   | Method | Controller Handler      | Body / Query                        |
| ----------------------- | ------ | ----------------------- | ----------------------------------- |
| `/providers`            | GET    | `getProviders`          | —                                   |
| `/stats`                | GET    | `getStats`              | `?provider=Name` (optional)         |
| `/content-type-mapping` | GET    | `getContentTypeMapping` | —                                   |
| `/purge-entry`          | POST   | `purgeEntry`            | `{ contentTypeUid, documentId }`    |
| `/purge-bulk`           | POST   | `purgeBulk`             | `{ contentTypeUid, documentIds[] }` |
| `/purge-all`            | POST   | `purgeAll`              | `{ provider? }` (optional)          |

---

## Admin-Side Architecture

### Content Manager Integration

**File:** `admin/src/index.tsx`

The plugin hooks into Strapi's Content Manager via its plugin API. The registration flow:

```typescript
const cmPlugin = app.getPlugin('content-manager');
cmPlugin.apis.addDocumentAction((prev) => [...prev, PurgeCacheDocumentAction]);
cmPlugin.apis.addBulkAction((prev) => [...prev, PurgeCacheBulkAction]);
```

Both use the **DescriptionReducer** pattern — a function that receives the existing array of actions and returns a new array with the custom action appended.

#### Document Action — `PurgeCacheDocumentAction`

This is a **DescriptionComponent**: a function that receives props and returns a description object (or `null` to hide the action).

**Props received from Strapi:**

| Prop             | Type                  | Description                                    |
| ---------------- | --------------------- | ---------------------------------------------- |
| `model`          | `string`              | Content type UID (e.g. `api::article.article`) |
| `document`       | `object \| undefined` | The current document being edited              |
| `documentId`     | `string \| undefined` | The document's unique ID                       |
| `collectionType` | `string`              | `'single'` or `'collection'`                   |
| `activeTab`      | `string \| null`      | `'draft'`, `'published'`, or `null`            |

**Visibility logic:** Returns `null` (hidden) when `documentId` or `document` is falsy — this covers:

- The "create new" view (no document yet)
- Edge cases where the document hasn't loaded

**Action description returned:**

```typescript
{
  label: 'Purge Cache',
  icon: <PluginIcon />,
  variant: 'secondary',
  position: ['panel', 'table-row'],   // Shown in edit view panel AND table row actions
  dialog: {
    type: 'dialog',
    title: 'Purge Cache',
    content: 'Are you sure you want to purge the cache for this entry?',
    onConfirm: async () => { await purgeEntry(model, documentId); }
  }
}
```

The `position` array makes the action available in two places:

- **panel** — The document actions dropdown in the edit view sidebar
- **table-row** — The actions column in the list view for individual rows

Because this is a DescriptionComponent (rendered within React context), it can use hooks like `useIntl()` and `useNotification()` for translations and toast notifications.

#### Bulk Action — `PurgeCacheBulkAction`

Same pattern, different props:

| Prop        | Type         | Description                              |
| ----------- | ------------ | ---------------------------------------- |
| `model`     | `string`     | Content type UID                         |
| `documents` | `Document[]` | Array of selected documents in list view |

The action extracts `documentId` from each selected document, filters out any nulls, and passes the full array to `purgeBulk()`. Returns `null` when no valid document IDs are selected.

The dialog shows the count of selected entries for clarity:

```
"Are you sure you want to purge the cache for 12 entries?"
```

### Settings Dashboard

**File:** `admin/src/pages/Settings.tsx`

A React component using Strapi's design system. It is lazy-loaded when the user navigates to Settings > Cache Manager.

**State management:**

| State                | Type                                      | Purpose                                              |
| -------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `providers`          | `ProviderSummary[]`                       | List of configured providers                         |
| `stats`              | `StatsResult[]`                           | Cache statistics from each provider                  |
| `mapping`            | `Record<string, ContentTypeMappingEntry>` | Content type mapping read from config                |
| `loading`            | `boolean`                                 | Initial data loading indicator                       |
| `purging`            | `string \| null`                          | Name of provider currently being purged (or `'all'`) |
| `showPurgeAllDialog` | `boolean`                                 | Controls confirmation dialog visibility              |

**Data loading:** On mount, the component fetches providers, stats, and the content type mapping in parallel:

```typescript
const [providersData, statsData, mappingData] = await Promise.all([
  fetchProviders(),
  fetchStats(),
  fetchContentTypeMapping(),
]);
```

After any purge operation, `loadData()` is called again to refresh statistics.

**UI sections:**

1. **Header** — Title, subtitle, refresh button, and "Purge All Caches" button with a confirmation dialog.

2. **Providers Table** — One row per provider showing:
   - Name (plain text)
   - Type (badge)
   - Available endpoints (badges: `purge`, `ban`, `purgeAll`, `stats`)
   - Per-provider "Purge" button (only shown if `purgeAll` endpoint exists)

3. **Content Type Mapping Table** — Read-only view of the `contentTypeMapping` config. One row per content type showing:
   - Content type name (friendly display name + full UID below it)
   - Path pattern (badge, or `—` if not set)
   - Related paths (badges, or `—` if none)
   - Behavior (`Purge All` badge if `purgeAllOnChange: true`, otherwise `—`)

4. **Cache Statistics** — One card per provider that has a `stats` endpoint:
   - Provider name + connection status badge (`Connected` / `Error`)
   - JSON stats data displayed in a preformatted block
   - Error message in red if the stats call failed

**Confirmation dialogs:** The "Purge All" button uses Strapi's `Dialog` compound component (`Dialog.Root`, `Dialog.Trigger`, `Dialog.Content`, `Dialog.Header`, `Dialog.Body`, `Dialog.Footer`, `Dialog.Cancel`, `Dialog.Action`). Per-provider purge buttons do not have a confirmation dialog — they purge immediately on click.

### API Client Layer

**File:** `admin/src/api.ts`

Uses `getFetchClient` from `@strapi/strapi/admin`, which provides a pre-configured `fetch` wrapper that:

- Automatically attaches the admin JWT token
- Handles base URL resolution
- Returns `{ data }` from JSON responses

The base path is `/cache-manager` (matching the plugin's admin-api routes).

| Function                    | HTTP Call                                 | Notes                                   |
| --------------------------- | ----------------------------------------- | --------------------------------------- |
| `fetchProviders()`          | `GET /cache-manager/providers`            | Returns `ProviderSummary[]`             |
| `fetchStats(provider?)`     | `GET /cache-manager/stats`                | Optional provider filter                |
| `fetchContentTypeMapping()` | `GET /cache-manager/content-type-mapping` | Returns full mapping object             |
| `purgeEntry(uid, docId)`    | `POST /cache-manager/purge-entry`         | Body: `{ contentTypeUid, documentId }`  |
| `purgeBulk(uid, docIds)`    | `POST /cache-manager/purge-bulk`          | Body: `{ contentTypeUid, documentIds }` |
| `purgeAll(provider?)`       | `POST /cache-manager/purge-all`           | Optional `{ provider }` body            |

---

## Request Flows

### Flow 1: Single Entry Purge

```
Editor clicks "Purge Cache" in document actions dropdown
   │
   ▼
Confirmation dialog shown: "Are you sure?"
   │ [Confirm]
   ▼
admin/src/api.ts → POST /cache-manager/purge-entry
  { contentTypeUid: "api::article.article", documentId: "abc123" }
   │
   ▼
cache-controller.purgeEntry(ctx)
  1. Validate body (contentTypeUid + documentId required)
  2. Fetch entry: strapi.documents("api::article.article").findOne({ documentId: "abc123" })
     → returns { slug: "my-article", title: "My Article", ... }
  3. Delegate to service
   │
   ▼
cache-service.purgeEntry("api::article.article", entry)
  1. Look up contentTypeMapping["api::article.article"]
     → { pathPattern: "/news/{slug}", relatedPaths: ["/news", "/"] }
  2. Check purgeAllOnChange? No.
  3. Resolve paths:
     - "/news/{slug}" → "/news/my-article"
     - relatedPaths → "/news", "/"
     - deduplicated: ["/news/my-article", "/news", "/"]
  4. For each provider:
     For each path:
       - If provider has `purge` endpoint → executeEndpoint(provider, 'purge', { path })
       - If provider has `ban` endpoint   → executeEndpoint(provider, 'ban', { path })
   │
   ▼
executeEndpoint("HTML Cache", "purge", { path: "/news/my-article" })
  1. endpoint config: { url: "http://localhost:4321/cm/cache", method: "GET",
                        params: { action: "html-clear-path" },
                        pathParam: "path", pathLocation: "query" }
  2. Resolve env vars in URL (none in this case)
  3. Apply path: params.path = "/news/my-article"
  4. Build URL: http://localhost:4321/cm/cache?action=html-clear-path&path=%2Fnews%2Fmy-article
  5. fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } })
  6. Return PurgeResult
   │
   ▼
Results aggregated and returned to admin UI
   │
   ▼
Toast notification: "Cache purged successfully"
```

For the Vienna Capitals config (2 providers, 3 paths), this results in **6 HTTP calls** (2 providers x 3 paths x 1 endpoint each, since neither Redis provider has a `ban` endpoint).

### Flow 2: Bulk Entry Purge

```
Editor selects 5 articles in list view → clicks "Purge Cache (5)"
   │ [Confirm]
   ▼
POST /cache-manager/purge-bulk
  { contentTypeUid: "api::article.article", documentIds: ["id1", "id2", "id3", "id4", "id5"] }
   │
   ▼
Controller: Fetches all 5 entries from Strapi document service
   │
   ▼
cache-service.purgeBulk("api::article.article", [entry1, entry2, ...])
  1. Resolve paths for each entry:
     - entry1: ["/news/article-one", "/news", "/"]
     - entry2: ["/news/article-two", "/news", "/"]
     - entry3: ["/news/article-three", "/news", "/"]
     - ...
  2. Deduplicate: Set { "/news/article-one", "/news/article-two", "/news/article-three",
                        "/news/article-four", "/news/article-five", "/news", "/" }
     = 7 unique paths (not 15)
  3. For each provider, for each path: call purge (and ban if configured)
```

Path deduplication is critical for bulk operations. Without it, purging 20 articles would call `/news` and `/` 20 times each.

### Flow 3: Purge All from Dashboard

```
Admin clicks "Purge All Caches" → Confirms in dialog
   │
   ▼
POST /cache-manager/purge-all
  {} (empty body = all providers)
   │
   ▼
cache-service.purgeAll()
  For each provider that has a purgeAll endpoint:
    executeEndpoint(provider, 'purgeAll')
   │
   ▼
For "HTML Cache":
  DELETE http://localhost:4321/cm/cache?type=html

For "Strapi Data Cache":
  DELETE http://localhost:4321/cm/cache?type=strapi
   │
   ▼
Results returned → Stats refreshed → UI updated
```

### Flow 4: Statistics Loading

```
Settings page mounts → loadData()
   │
   ▼
GET /cache-manager/providers → Returns provider summaries (no sensitive data)
GET /cache-manager/stats     → For each provider with stats endpoint, calls it
   │
   ▼
For "HTML Cache" stats:
  GET http://localhost:4321/cm/cache?action=html-stats
  → { totalKeys: 42, pathStats: { "/": 1, "/news": 3, ... } }

For "Strapi Data Cache" stats:
  GET http://localhost:4321/cm/cache?action=strapi-stats
  → { totalKeys: 128, contentTypeKeys: { article: 45, page: 20, ... } }
   │
   ▼
Rendered in dashboard as JSON blocks with Connected/Error badges
```

---

## Provider System

### Endpoint Schema

Each endpoint in a provider follows this schema:

```typescript
interface ProviderEndpoint {
  url: string; // The base URL to call
  method: string; // HTTP method: GET, POST, PUT, DELETE
  headers?: object; // Additional headers to send
  params?: object; // Static query parameters (merged with path param)
  pathParam?: string; // Name of the param/header that receives the path value
  pathLocation?: string; // 'query' (default) or 'header'
}
```

A provider defines up to 4 endpoints:

| Key        | Required | Used By                                   |
| ---------- | -------- | ----------------------------------------- |
| `purge`    | No       | purgeEntry, purgeBulk (per-path)          |
| `ban`      | No       | purgeEntry, purgeBulk (per-path, Varnish) |
| `purgeAll` | No       | purgeAll, dashboard "Purge" buttons       |
| `stats`    | No       | dashboard statistics section              |

All endpoints are optional. A provider with only `purgeAll` is valid (manual purge only). A provider with only `stats` is valid (monitoring only, no purging).

### Environment Variable Interpolation

The `resolveEnvVars` function scans strings for `${VAR_NAME}` patterns and replaces them with `process.env[VAR_NAME]`:

```
"${CLIENT_URL}/cm/cache"  →  "http://web:4321/cm/cache"
"Bearer ${CACHE_API_KEY}" →  "Bearer abc123"
"${UNDEFINED_VAR}"        →  ""  (empty string, not an error)
```

**Resolution happens at request time**, not at config load time. This means:

- Env vars can be changed between requests (useful for dev, not typical in prod)
- Missing env vars produce empty strings rather than startup failures

Applied to: `url`, all `headers` values, all `params` values.

### Path Delivery Mechanisms

When purging a specific path (e.g. `/news/my-article`), the plugin needs to tell the cache system which URL to purge. Different systems expect this in different places:

**Query parameter (default)** — `pathLocation: 'query'`

```
GET http://localhost:4321/cm/cache?action=html-clear-path&path=/news/my-article
                                                          ^^^^^^^^^^^^^^^^^^^^
                                                          pathParam = 'path'
```

**HTTP header** — `pathLocation: 'header'`

```
POST http://varnish:80/varnish-purge
X-Purge-Token: secret123
X-Purge-URL: /news/my-article       ← pathParam = 'X-Purge-URL'
```

The `pathParam` field names the query parameter or header. The `pathLocation` field determines where it goes.

### Provider Examples Walkthrough

#### Redis via HTTP API (this project)

The web app exposes `/cm/cache` with query-parameter-based actions. The plugin calls it directly:

```
purge:    GET  /cm/cache?action=html-clear-path&path=/news/slug
purgeAll: DELETE /cm/cache?type=html
stats:    GET  /cm/cache?action=html-stats
```

No authentication headers needed (internal network). Path is delivered as a query param.

#### Varnish

Varnish uses custom HTTP methods/headers for cache management:

```
purge: POST /varnish-purge
       X-Purge-Token: ${VARNISH_PURGE_TOKEN}
       X-Purge-URL: /news/slug                ← path in header

ban:   POST /varnish-ban
       X-Purge-Token: ${VARNISH_PURGE_TOKEN}
       X-Ban-URL: /news/slug                  ← path in header
```

Both `purge` and `ban` are called for each path. `purge` removes the exact URL; `ban` adds a ban expression that can match patterns.

#### CDN (Cloudflare example)

CDNs typically have purge-all APIs but per-URL purge requires different request shapes:

```
purgeAll: POST https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache
          Authorization: Bearer ${CF_API_TOKEN}
          (body: { "purge_everything": true })  ← Note: body not yet supported
```

> The current implementation does not send request bodies. For CDN APIs that require a JSON body, the `ProviderEndpoint` interface would need a `body` field. See [Future Considerations](#future-considerations).

---

## Content Type Mapping In Depth

### Path Resolution Algorithm

The `resolvePaths(contentTypeUid, entry)` method:

```
1. Look up contentTypeMapping[contentTypeUid]
   Not found → return [] (no paths to purge; logged as info)

2. Check purgeAllOnChange
   If true → caller will invoke purgeAll() instead (short-circuit)

3. Resolve pathPattern (if present):
   Replace every {fieldName} with String(entry[fieldName] || '')
   Push resolved path to results array

4. Append relatedPaths (if present):
   Push each related path to results array

5. Deduplicate:
   return [...new Set(paths)]
```

### Field Substitution

The `{fieldName}` syntax works with any top-level field on the entry:

```typescript
// Mapping
{ pathPattern: '/news/{slug}' }

// Entry
{ slug: 'my-article', title: 'My Article', id: 42 }

// Result
'/news/my-article'
```

You can use multiple fields:

```typescript
// Mapping
{ pathPattern: '/{locale}/news/{slug}' }

// Entry
{ locale: 'en', slug: 'my-article' }

// Result
'/en/news/my-article'
```

The `slugField` config option exists for documentation/convention but the substitution system reads any `{fieldName}` — it is not limited to the `slug` field.

### Edge Cases

| Scenario                                              | Behavior                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Content type not in mapping                           | Returns `[]` — no purge calls made, info logged                     |
| Entry has no slug field                               | `{slug}` resolves to empty string → path becomes `/news/`           |
| `purgeAllOnChange: true`                              | Ignores pathPattern and relatedPaths; purges everything             |
| `relatedPaths` without `pathPattern`                  | Only the related paths are purged (valid for types like `category`) |
| Duplicate paths across `pathPattern` + `relatedPaths` | Deduplicated via `Set`                                              |
| Bulk purge with overlapping related paths             | Paths deduplicated across all entries                               |

---

## Security Model

### Authentication

All admin API routes are protected by the `admin::isAuthenticatedAdmin` policy. This ensures:

- Only logged-in Strapi admin users can trigger purges
- The admin JWT token is verified on every request
- No public API exposure

The admin fetch client (`getFetchClient`) automatically attaches the JWT token to requests.

### Provider Credentials

Credentials for external cache systems (API keys, tokens) are stored in environment variables and referenced via `${VAR_NAME}` syntax. They are:

- Never stored in the database
- Never exposed to the admin UI (the `getProviderSummary()` method strips URLs and headers)
- Resolved at request time on the server side

### No Content-API Routes

The plugin deliberately uses only `admin-api` type routes (not `content-api`). This means:

- No public endpoints exist
- Cache purging cannot be triggered via the Strapi REST/GraphQL API
- Only the admin panel can initiate purges

---

## Error Handling

The plugin follows a **never-throw** pattern. All errors are captured and returned as structured results:

### Service Layer

`executeEndpoint` catches all errors (network failures, DNS resolution failures, timeouts, JSON parse errors) and returns a `PurgeResult` with `success: false`:

```typescript
{
  provider: 'Varnish',
  endpoint: 'purge',
  success: false,
  message: 'purge failed on Varnish: fetch failed'
}
```

Non-2xx HTTP responses are also treated as failures:

```typescript
{
  provider: 'HTML Cache',
  endpoint: 'purge',
  success: false,
  status: 500,
  message: 'purge failed on HTML Cache: HTTP 500'
}
```

### Controller Layer

The controller wraps service calls in try/catch. If the service itself throws unexpectedly, the controller returns `ctx.internalServerError()`. All successful operations (even partial failures) return `{ success: true, results: [...] }`.

### Admin UI

The admin UI shows toast notifications (`toggleNotification`) for success and failure. Network errors from `getFetchClient` are caught in the `onConfirm` handlers of document/bulk actions and in the settings page handlers.

### Logging

All operations are logged via `strapi.log`:

```
[cache-manager] Purged cache for api::article.article / abc123: 4/6 succeeded
[cache-manager] Bulk purge for api::article.article (5 entries): 12/14 succeeded
[cache-manager] Purge all: 2/2 succeeded
[cache-manager] No paths to purge for api::unknown.unknown
```

---

## Internationalization

The plugin ships with English (`en.json`) and German (`de.json`) translations. All user-facing strings use `react-intl`'s `formatMessage` with `id` and `defaultMessage`.

Translation key naming convention:

```
cache-manager.settings.*         — Dashboard page strings
cache-manager.action.purge.*     — Single entry action strings
cache-manager.action.purge-bulk.*— Bulk action strings
```

**Adding a new language:** Create a new JSON file at `admin/src/translations/{locale}.json` (e.g. `fr.json`). The `registerTrads` function in `admin/src/index.tsx` automatically discovers and loads it based on the active Strapi locale.

**Parameterized messages** use ICU MessageFormat syntax:

```json
"cache-manager.action.purge-bulk": "Purge Cache ({count})"
```

---

## Adapting to Other Projects

To use this plugin in a different Strapi 5 project:

### Step 1: Install the package

```bash
npm install @leancoders/strapi-plugin-cache-manager
# or
pnpm add @leancoders/strapi-plugin-cache-manager
# or
yarn add @leancoders/strapi-plugin-cache-manager
```

### Step 2: Configure providers

Define providers that match your cache infrastructure. The plugin doesn't need to know what kind of cache you're using — only how to call its HTTP endpoints.

**Minimum viable config:**

```typescript
'cache-manager': {
  enabled: true,
  resolve: './src/plugins/cache-manager',
  config: {
    providers: [
      {
        name: 'My Cache',
        type: 'http',
        endpoints: {
          purgeAll: {
            url: 'http://my-cache-service/purge',
            method: 'POST',
          },
        },
      },
    ],
  },
},
```

This gives you a dashboard with a "Purge All" button. No per-entry purging (no `purge` endpoint), no stats.

### Step 3: Add content type mapping (optional)

Only needed if you want per-entry purging. Map your content types to your frontend URL structure:

```typescript
contentTypeMapping: {
  'api::blog-post.blog-post': {
    pathPattern: '/blog/{slug}',
    relatedPaths: ['/blog'],
  },
},
```

### Step 4: Build and run

```bash
pnpm develop
```

---

## Troubleshooting

### Plugin doesn't appear in Settings

- Verify `enabled: true` in `config/plugins.ts`
- Verify the package is installed: `npm ls @leancoders/strapi-plugin-cache-manager`
- Check the Strapi startup logs for `[cache-manager]` messages

### "No cache providers configured" warning

- The `providers` array in your config is empty or missing
- Verify the config is in the `config` key, not at the top level of the plugin definition

### Purge calls fail silently

- Check Strapi logs for `[cache-manager]` entries with success/failure counts
- Verify the cache endpoint URLs are reachable from the Strapi server
- Check environment variables are set correctly (`echo $CLIENT_URL` on the server)
- Try calling the endpoint manually: `curl http://localhost:4321/cm/cache?action=html-stats`

### Document action not showing

- Verify the content-manager plugin is loaded before cache-manager
- The action is hidden when `documentId` or `document` is null (e.g. "create new" view)
- Check browser console for JavaScript errors

### Bulk action not showing

- You must select at least one entry in the list view
- The action only appears in the bulk action toolbar after selection

### Environment variable not resolving

- `${VAR_NAME}` must exactly match the env var name (case-sensitive)
- Missing env vars resolve to empty string (not an error)
- Env vars are resolved at request time, not at startup — restart isn't needed for env changes, but a config change in `plugins.ts` requires restart

---

## Future Considerations

These are potential enhancements that are not yet implemented:

1. **Request bodies** — Add a `body` field to `ProviderEndpoint` for CDN APIs that require JSON payloads (e.g. Cloudflare's `{ "purge_everything": true }`).

2. **Webhook integration** — Add a content-api route that can be called by external webhooks (e.g. CI/CD pipelines) to trigger purges.

3. **Lifecycle hook integration** — Automatically purge cache when content is published/updated, replacing the manual `cache-clearer.ts` utility. This would make the `contentTypeMapping` serve double duty.

4. **Permissions** — Add granular Strapi permissions (e.g. "can purge cache", "can purge all") to restrict which admin roles can trigger purges.

5. **Retry logic** — Add configurable retry with backoff for failed purge requests.

6. **Batch HTTP calls** — For bulk operations with many paths, batch purge requests to reduce HTTP overhead (provider-dependent).

7. **Async/background purging** — For large bulk operations, queue purge requests and process them in the background to avoid admin UI timeouts.

8. **Audit log** — Record who purged what and when, for compliance and debugging.
