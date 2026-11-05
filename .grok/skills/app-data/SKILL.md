---
name: app-data
description: >
  Call connector tools (Google Drive, Gmail, calendar, etc.) ONLY from the app
  backend via createServerFn + @/lib/app-data/client.server. NEVER from React
  components, useEffect, or browser fetch. Use when the app needs Drive data,
  connectors, CallTool, google_drive_*, x-connector-access-token,
  or /call-tool. Also use when the user says the data looks fake/mock/sample,
  asks to load their REAL calendar / email / files, asks why real data isn't
  showing, or claims/asks whether Grok sign-in can access their
  Google/Microsoft data. Grok sign-in + gate CallTool DOES provide the viewer's
  connector data — never claim it is impossible and never integrate a provider
  API directly. Agents MUST load this skill and discover the available tools
  (GatewayListTools with the app's project_id) before writing any connector
  integration.
metadata:
  short-description: "Backend-only connector CallTool (never frontend)"
---

# AppData skill — **backend only** (agents: read this fully)

Use this when the app needs a signed-in viewer's connector data — any connector
type (Google Drive, Gmail, calendar, Outlook, Teams, MCP, …). The one tool you
call is **`callTool`**, always with an explicit `connectorType`; everything else
is plumbing the SDK already handles. Google Drive is the worked example
throughout — the flow is identical for every connector type.

## Absolute rule for the agent

**Never make connector / AppData / gate CallTool requests from the frontend.**

| You MUST | You MUST NOT |
| --- | --- |
| Put all `callTool` inside `createServerFn({ method: "POST" })` | Call that API from components, hooks, `useEffect`, event handlers, or route loaders (loaders run on GET and are blocked) |
| Use `method: "POST"` for every connector server function | `method: "GET"` connector wrappers (a link/iframe/img GET from a sibling app can fire them) |
| Dynamic-import `@/lib/app-data/client.server` **inside** the server handler | Static-import the `.server` module from a route component file used on the client |
| Let the UI call only the **server function** | Browser `fetch` to the connectors host |
| Keep tokens on the server request | Expose `x-connector-access-token` or connector JWTs to the client |
| Use the SDK (resolves the public connectors host for the app's domain) | Call internal connector URLs from the app |

`callTool` itself also rejects scripted same-site / cross-site browser requests
(Fetch-Metadata isolation, same guard as `assertSameSiteRequest` in the auth
lib) with `{ ok: false, errorMessage: "Forbidden: cross-site request blocked" }`
— sibling `*.grok.me` apps are mutually untrusted. It additionally refuses any
non-POST inbound request (`blocked GET inbound request: …`), so a `method:
"GET"` server function or route loader cannot invoke tools even via a top-level
navigation. If the app uses the auth skill, additionally add
`.middleware([authMiddleware])` to connector server functions.

Correct architecture:

```
Browser UI
   │  only calls createServerFn (same app origin)
   ▼
App backend (Vercel / TanStack server)
   │  callTool() from @/lib/app-data/client.server
   │  uses gate-injected x-connector-access-token from the *inbound* request
   ▼
Public connectors host (auth required), resolved per environment:
   connectors.grok.me (prod) / connectors.app-builder-testing.com (staging),
   or GROK_CONNECTORS_URL override — POST /call-tool
   ▼
Gate verifies the session/JWT and runs the tool call as the viewer
```

## Prerequisite: the app must be granted the connector type

`callTool` runs as the **viewer** and only works when **both** are true:

1. The **builder granted this app** the connector *type* (e.g. `GoogleDrive`)
   with tool scopes — done from the publish / share flow, not from app code.
2. The **viewer has connected** that connector in Grok (their own OAuth tokens).

If the grant is missing you get a permission / `scope_denied` error; if the
viewer hasn't connected, you get a `not_connected` / `failed_precondition`
error. Both are **expected states** — render a friendly "connect your
Google Drive / Gmail / … in Grok" prompt for that connector, don't crash. The
app never uses the builder's tokens.

## Declare the app's connectors (mandatory)

Whenever the app calls a connector type, you MUST add it to `deploy.connectors`
in `.grok/app-env.json` — **merge into the existing JSON, never clobber it**
(the file also carries `VITE_*` env and `deploy.database`):

```json
{
  "VITE_AUTH_ENABLED": "false",
  "deploy": {
    "database": false,
    "connectors": ["GoogleCalendar", { "type": "Mcp", "catalog": "notion" }]
  }
}
```

Each entry is either a wire-name string — the `ConnectorType` PascalCase name:
`GoogleDrive`, `Gmail`, `GoogleCalendar`, `Outlook`, `OutlookCalendar`,
`Sharepoint`, `OneDrive`, `MicrosoftTeams`, `XAds`, `PowerBi` — or, for an MCP
catalog, the object form `{ "type": "Mcp", "catalog": "<connector name, e.g.
notion>" }`. The catalog name must match the connector's display name in Grok
exactly (case-insensitive, no abbreviations or edits) — resolution is a
name match against the grantable catalog, and a non-matching name silently
drops the entry from the grant dialog. Catalog uuids are NOT discoverable from
the sandbox — never research or invent one; `{ "type": "Mcp", "catalogId":
"<uuid>" }` remains valid only when a uuid is already known. Max 16 entries.
The deployer reads this list at publish to pre-select the connector grants in
the grant dialog; an inaccurate list forces the user to hand-pick every grant,
so keep it in sync with what the code actually calls.

### Verify the declared catalog is grantable (hard stop)

A connector you can use from your own agent-side tools, or that the user can
use in Grok chat, is NOT automatically grantable to apps — app grants are a
separately gated surface, and the mismatch is silent: the grant dialog skips
the entry and every viewer call fails with `permission_denied`. Your own
agent-side MCP tools prove nothing about the app's access — they run on the
builder's connection; the app runs on grants. So for every declared MCP
catalog:

1. After the grant exists (the owner approved the grant dialog in preview or
   publish), re-run tool discovery (`GatewayListTools` with this app's
   `project_id`) and confirm tools for that catalog appear.
2. If the grant dialog never offers the connector, or discovery never returns
   its tools after the owner granted, the catalog is **not grantable to apps**
   in this environment. **Stop building that integration.** Tell the user
   plainly: "<Name> is not currently grantable to apps, so the app cannot
   access viewers' <Name> data" and ask how to proceed (a different data
   source, or UI that renders labeled sample data). Never ship the
   integration on agent-side or guessed tool names — it cannot work at
   runtime for any viewer.

## Discover tools before you code (build phase)

Do not guess tool names — not even from the `GoogleDriveTools` table below.
Before writing any connector integration:

1. **List the tools this app may call** with your environment's tool discovery
   (the connectors `GatewayListTools` API called with this app's `project_id`).
   The response is already the exact runtime allowlist: the user's connected
   tools narrowed to the app's connector grants and the app-data catalog — no
   manual intersection needed. This is a build-time step for you, the agent —
   the generated app must never call it.
2. **Code only against the returned tools**, and bake the discovered tool names
   into the app at build time. A tool the user has in Grok chat but that is
   missing from the response is not callable from the app; anything outside the
   response must degrade gracefully (`scope_denied` → soft state), never be
   assumed to exist.

The deployed app has no discovery API: it authenticates with the gate-injected
token and can only `callTool`.

### MCP tool names are per-connector — never composed

An MCP tool is callable only under the exact name discovery returned: the bare
remote name as-is (e.g. `search`, `notion-search`) or the full
`<server>___<remote>` id. Never compose a name yourself — no
`<catalog>-<capability>` kebab-case guesses (`notion-list-recent-pages`), no
prefix/suffix edits of a discovered name, no names copied from another
connector or its public docs. The grant stores the discovered names as its
scopes, so an invented name always fails at runtime with `scope_denied` even
when the grant, catalog, and connection are all correct (a built app lost its
entire Notion column exactly this way). If no discovered tool covers a
capability, build it from the closest real tool (e.g. a search sorted by
last-edited for "recent docs") or render the soft state — inventing a name is
never a fallback. If discovery returns no tools for an MCP catalog the app
needs, stop and re-run discovery once the grant exists; never proceed on
guessed names.

## The one API

`@/lib/app-data/client.server` (server handlers only):

```ts
callTool(
  toolName: string,
  args: Record<string, unknown>,
  options: {
    connectorType: ConnectorTypeName;
    connectorCatalogId?: string;
    token?: string | null;
  },
): Promise<{
  ok: boolean;
  data: unknown | null;
  errorMessage?: string;
  loginRequired?: boolean;
  loginUrl?: string;
  pending?: boolean;
}>
```

`connectorType` is **required** on every call: pass the connector type granted
to this app (a `ConnectorType.*` value, e.g. `ConnectorType.Gmail`). There is
no default — omitting it returns `{ ok: false }` with an explanatory
`errorMessage`. For `ConnectorType.Mcp`, set `connectorCatalogId` to the
**catalog name** from the manifest (e.g. `"notion"`, case-insensitive; a uuid
also works when one is already known — never invent one). When the app has
exactly one MCP grant, `connectorCatalogId` may be omitted entirely; with
several MCP grants an omitted value fails with an error listing the granted
catalogs.

Types & constants (safe to import anywhere, **no network**): `@/lib/app-data` —
`ConnectorType`, `ConnectorTypeName`, `GoogleDriveTools`, `GoogleCalendarTools`,
`CallToolResult`, `CallToolOptions`, `ToolArgs`, the client-safe login helpers
`redirectToLoginIfRequired`, `isLoginRequired`, `isConnectorPending`, and the
`useRefetchWhenConnectorReady` hook (see "Preview: wait for the connector
token" below).

## Required pattern (copy this)

Google Drive worked example — for any other connector type, swap the tool name
(from discovery) and the `connectorType`:

```ts
import { createServerFn } from "@tanstack/react-start";

export const searchDrive = createServerFn({ method: "POST" })
  .validator((data: { query: string }) => data)
  .handler(async ({ data }) => {
    const { callTool, ConnectorType, GoogleDriveTools } = await import(
      "@/lib/app-data/client.server"
    );
    const res = await callTool(
      GoogleDriveTools.search,
      { query: data.query, max_results: 50 },
      { connectorType: ConnectorType.GoogleDrive },
    );
    return { ...res, files: res.ok ? extractFiles(res.data) : [] };
  });
```

Return the **whole `CallToolResult`** (spread it as above) — never collapse it
to `{ ok, error }`. Stripping `loginRequired` / `loginUrl` breaks the login
redirect flow below, and stripping `pending` breaks the preview wait below.

```tsx
import { searchDrive } from "@/lib/drive.functions";
```

If the `createServerFn` lives in the same file as a component, still keep the
`callTool` import **inside** `.handler(async () => { await import(…) })`.

## Sample through the app's own path (before writing any parser)

Obtain one REAL response **through the app's own `callTool` code path** — run
the server function (or hit the gated endpoint) and log `res.data` — before
shaping a parser. Do NOT parse the shape your own agent-side connector tools
return: the envelopes differ (the agent harness unwraps tool results; the
template's `callTool` returns the gate's `data` field verbatim —
`data: json.data ?? null` in `src/lib/app-data/client.server.ts`, no
client-side reshaping). A built app parsed the agent-side shape and met a
different nesting at runtime. MCP tools especially may arrive as MCP content
blocks — `{ content: [{ type: "text", text: "<json>" }] }` whose `text` needs
`JSON.parse` — rather than plain JSON.

## Reading the result (`res.data`)

`res.data` is the gate's already-parsed JSON payload (the gate unwraps the
protobuf Struct / content; the SDK passes its `data` through unchanged).
**Shapes vary per tool**, so normalize
defensively — do not assume a fixed key or casing. Drive list/search tools
return an array under one of `files` / `items` / `results` / `entries`, and each
file may use snake_case or camelCase:

```ts
type DriveFile = {
  fileId: string; name: string; mimeType: string;
  sizeBytes: number; modifiedTime: string; ownerName: string;
  webViewLink?: string;
};

function asRecord(v: unknown) {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function extractFiles(data: unknown): DriveFile[] {
  const root = asRecord(data);
  if (!root) return [];
  const rows =
    (Array.isArray(root.files) && root.files) ||
    (Array.isArray(root.items) && root.items) ||
    (Array.isArray(root.results) && root.results) ||
    (Array.isArray(root.entries) && root.entries) || [];
  return rows.flatMap((raw) => {
    const f = asRecord(raw);
    const fileId = str(f?.file_id ?? f?.fileId ?? f?.id);
    if (!f || !fileId) return [];
    return [{
      fileId,
      name: str(f.name ?? f.title) || "(untitled)",
      mimeType: str(f.mime_type ?? f.mimeType),
      sizeBytes: num(f.size_bytes ?? f.sizeBytes ?? f.size),
      modifiedTime: str(f.modified_time ?? f.modifiedTime),
      ownerName: str(f.owner_name ?? f.ownerName),
      webViewLink: str(f.web_view_link ?? f.webViewLink) || undefined,
    }];
  });
}
```

**Parse leniently.** Treat every field you did not observe in a real sampled
response as optional: never make a row's inclusion depend on a field the
server may not send (an app dropped 20 Notion pages by requiring an `id` the
server never sends). Derive missing keys (fall back through aliases, index, a
hash of stable fields) and render partial rows with placeholders rather than
filtering them out. The id gate above is the ceiling, not the pattern: only
drop a row when it is unusable even for display.

## Google Drive tools (`GoogleDriveTools`)

Example constants for the Drive catalog as of this template — **discovery
(above) is the source of truth**, and only tools inside the app's grant work.

| Constant | Tool name | Typical args | Returns |
| --- | --- | --- | --- |
| `GoogleDriveTools.search` | `google_drive_search` | `{ query?, starred?, shared_with_me?, owner_email?, max_results? }` | `{ files: [...] }` |
| `GoogleDriveTools.listFolder` | `google_drive_list_folder` | `{ folder_id? }` (root when omitted) | `{ files: [...] }` |
| `GoogleDriveTools.readFile` | `google_drive_read_file` | `{ file_id }` | file content / metadata |
| `GoogleDriveTools.createFolder` | `google_drive_create_folder` | `{ name, parent_id? }` | created folder |
| `GoogleDriveTools.trashFile` | `google_drive_trash_file` | `{ file_id }` | status |

Example (parallel filtered searches, from the smoke test):

```ts
const drive = { connectorType: ConnectorType.GoogleDrive };
const [recent, starred, shared] = await Promise.all([
  callTool(GoogleDriveTools.search, {}, drive),
  callTool(GoogleDriveTools.search, { starred: true }, drive),
  callTool(GoogleDriveTools.search, { shared_with_me: true }, drive),
]);
```

## Google Calendar tools (`GoogleCalendarTools`)

There is **no** `google_calendar_list_events`. Week/day views use `search`
with `time_min` / `time_max` (RFC3339). Discovery is still the source of
truth; these names match the current catalog.

| Constant | Tool name | Typical args |
| --- | --- | --- |
| `GoogleCalendarTools.listCalendars` | `google_calendar_list_calendars` | `{}` |
| `GoogleCalendarTools.search` | `google_calendar_search` | `{ time_min, time_max, query?, calendar_id? }` |
| `GoogleCalendarTools.getEvent` | `google_calendar_get_event` | `{ event_id, calendar_id? }` |
| `GoogleCalendarTools.availability` | `google_calendar_availability` | `{ time_min, time_max }` |

```ts
const cal = { connectorType: ConnectorType.GoogleCalendar };
const week = await callTool(
  GoogleCalendarTools.search,
  { time_min: startIso, time_max: endIso },
  cal,
);
```

## Error states to handle (don't crash the app)

`callTool` never throws — it returns `{ ok: false, errorMessage }`. Classify
failures with **`classifyCallToolError(res)`** from `@/lib/app-data` — never
hand-roll `errorMessage` string matching (a built app labeled a `scope_denied`
as a missing grant and misled its owner). It returns `null` on success, else
`{ kind, message, detail }`:

| `kind` | Meaning | UI |
| --- | --- | --- |
| `pending` | workspace preview only: the connector token has not reached the sandbox yet, or the gate rejected the current (expired) one and the panel has not pushed a fresh one (`pending: true`) | **Not an error.** Spinner + "Connecting to <connector>…"; `useRefetchWhenConnectorReady` refetches by itself once the token lands (see "Preview: wait for the connector token") |
| `login` | deployed only: gate could not verify the token/session (`loginRequired: true`) | "Continue with Grok" → `redirectToLoginIfRequired(res)` (see below). **Not** `missing_connector_token` — a deployed request that bypassed the gate classifies as `error` ("Open this app from Grok"); no sign-in can fix it |
| `not_connected` | viewer hasn't connected this connector in Grok | "Connect your Google Drive / Gmail / … in Grok" |
| `scope_denied` | tool not in the app's grant scopes | soft state ("view unavailable" / treat as empty) — never present it as a missing grant or ask the user to re-grant |
| `access_denied` | authenticated but not allowed (not a login problem) | "You don't have access" |
| `error` | tool/runtime error | show `message`, offer manual retry |

Every error state must also render `detail` (the raw `errorMessage`) as small
secondary text — that line is how owners diagnose failures without DevTools.

```ts
const err = classifyCallToolError(res);
if (err) return { status: "error", ...err };
```

### Error kind → required UX (mandatory)

Sign-in cannot fix a data error — a built app answered a
`missing_connector_token` failure with a "Continue with Grok" button, which can
never succeed. Map every `kind` exactly:

| `kind` | Sign-in CTA? | Required UX |
| --- | --- | --- |
| `pending` | NEVER | Loading state ("Connecting to <connector>…" with a spinner) while `useRefetchWhenConnectorReady` returns `"waiting"`; when it returns `"timed_out"`, "Still connecting — make sure <connector> is allowed for this app in the Grok preview panel" plus a manual "Try again"; when it returns `"not_embedded"` (the page is top-level, not framed by any preview: download/export, local `npm run dev`, `npm run preview`), "Open this app from Grok to load your data." with no spinner and no retry. Never "unavailable", never "reload", never a sign-in button |
| `login` | Deployed only — the ONLY kind that ever shows one | "Continue with Grok" → `redirectToLoginIfRequired(res)` in the click handler |
| `not_connected` | NEVER | "Connect <connector name> in Grok" guidance |
| `scope_denied` | NEVER | Soft state ("view unavailable" / empty) — never a re-grant ask |
| `access_denied` | NEVER | "You don't have access to this data." |
| `error` | NEVER | Show `message`, offer manual "Try again" |

- `not_connected`, `scope_denied`, `access_denied` and `error` are **data
  errors**: rendering a sign-in / "Continue with Grok" CTA for them is always a
  bug — signing in changes nothing.
- Never render a raw SDK error string (e.g. `connector_token_pending: the
  preview has not received…`) as the consumer-facing message. The visible copy
  is the mapped `message`/state above; the raw `errorMessage` appears only as
  the small secondary `detail` line.

### Preview: wait for the connector token (mandatory for connector views)

In the workspace preview the connector token is pushed into the sandbox by the
Grok preview panel **after** the owner approves the connector grant — often
seconds to minutes after your dev server is already up. Until then every
`callTool` returns `{ ok: false, pending: true }` (`kind: "pending"`). That is
a **transient loading state, not a failure**, and the user must never have to
reload or press "Try again" to get past it. Wire the pre-built hook next to
the connector query:

```tsx
import { classifyCallToolError, useRefetchWhenConnectorReady } from "@/lib/app-data";

const { data: res, refetch, isFetching } = useQuery({
  queryKey: ["week", weekStart],
  queryFn: () => loadWeek({ data: { weekStart } }),
  retry: false,
});
const err = res ? classifyCallToolError(res) : null;
const wait = useRefetchWhenConnectorReady(err?.kind === "pending", refetch);

if (isFetching || wait === "waiting") return <Connecting connector="Google Calendar" />;
if (wait === "timed_out") return <StillConnecting onRetry={refetch} detail={err?.detail} />;
if (wait === "not_embedded") return <OpenFromGrok />;
```

`useRefetchWhenConnectorReady(waiting, refetch)` probes the app's **own
server** (a header check — it never calls the gate, so it is exempt from the
no-polling rules below) with backoff for up to three minutes, and also listens
for the preview panel's "token ready" signal so the refetch fires the moment
the token lands. It calls `refetch` once a token the gate has not rejected is
present and returns `"idle" | "waiting" | "timed_out" | "not_embedded"`. The
three-minute limit is a wall-clock deadline, so a probe that hangs or a
`refetch` that throws still ends in `"timed_out"`. A top-level page (not
framed at all) can never receive a token, so the hook reports
`"not_embedded"` at once without probing; any framed page probes. Never
reimplement this with your own interval, and never poll `callTool` itself.

## Never fabricate connector data

Connector-backed views show the **viewer's real data or an explicit state** —
never invented rows. No seeded/sample events, files, or emails standing in for
real connector data: empty is empty ("no events this week"), failed is failed
(the mapped state from the table above). Demo data is allowed only when the UI
visibly labels it "Sample data" — never as a silent fallback when a call fails
or returns nothing.

## Fetch live, don't mirror

The connector is the **source of truth**. Connector-backed views fetch through
the server function on load or on an explicit refresh — don't copy connector
data into the app database and serve stale mirrors. If you cache, show the
data's staleness visibly and give a refresh affordance.

## Timezone-stable dates

Never compute date ranges or labels during SSR render from local `now()` — when
midnight UTC crosses between server render and client hydration the two renders
disagree ("Aug 23 – Aug 30" vs "Aug 24 – Aug 31") and the page
hydration-mismatches. Compute date ranges client-side (after mount) or pass one
explicit clock value into both renders.

## Fetch discipline (mandatory)

Connector fetches run **once on mount**, on **explicit user action** (a
Refresh button), and when **`useRefetchWhenConnectorReady` fires** (the only
automatic refetch — it is gated on the token actually being present) — nothing
else. No polling, no `refetchInterval`, no effect
that re-fires on its own result. On error, render the mapped error state and
**stop**: at most one retry with backoff, never continuous (a built app hit
~4 req/s against the gate from an effect-refetch loop). During a manual
refresh keep the previous data visible with a spinner on the button — never
re-flash skeletons over data you already have.

## No retry loops (mandatory)

A failed `callTool` is a **resolved value, not an exception** — your query/state
layer will not see a rejected promise, so any "retry until it works" logic you
write yourself becomes an infinite request loop that freezes the tab and hammers
the platform (the SDK also memoizes identical failures for 5s server-side, so
tight retries only return the cached failure).

- Failure is a **terminal UI state**: render the mapped message from the table
  above. Never key a skeleton/spinner off `!res.ok` or `!data` — that renders
  "loading" forever on failure. The one non-terminal `ok: false` is
  `kind: "pending"`, which `useRefetchWhenConnectorReady` owns.
- Never refetch automatically on failure: no `useEffect` that re-fires when the
  result is `ok: false`, no `refetchInterval` on error, no unbounded
  `retry` in query options. If you use TanStack Query, set `retry: 1` or
  `retry: false` for connector queries.
- Retry only on **explicit user action** (a "Try again" button).

## Login / session renewal

The gate mints a **short-lived** connector token (~5 min) and injects a fresh
one on every request it proxies. The app never refreshes the token itself — it
re-authenticates by making another request **through the gate**. When the token
or gate session can't be verified, `callTool` returns `loginRequired: true`
(HTTP 401). Because `callTool` runs on the server but the redirect must happen
in the browser, **return the result to the client and call
`redirectToLoginIfRequired` there**:

```tsx
import { redirectToLoginIfRequired } from "@/lib/app-data";
import { searchDrive } from "@/lib/drive.functions";

async function onSearch(query: string) {
  const res = await searchDrive({ data: { query } });
  if (redirectToLoginIfRequired(res)) return;
  if (!res.ok) {
    showError(res.errorMessage ?? "search failed");
    return;
  }
  renderFiles(res.files);
}
```

Pass the `CallToolResult` straight through your server function (don't strip
`loginRequired` / `loginUrl`). The helper navigates to `res.loginUrl` — the
gate sign-in URL the server built, which already carries `return_to` back to
the gated app — and when the app is embedded (e.g. the Grok preview iframe) it
opens that URL in a new tab instead, because sign-in pages refuse to render in
a frame. Always use the helper; never hand-roll the redirect with
`window.location`, which dead-ends framed viewers on a blocked page. Never try
to mint or refresh a token from app code — the gate is the only issuer.

In the **workspace preview**, a connector token that has not arrived yet, or
one the gate rejected (expired — the preview panel re-mints and pushes a fresh
one on its own schedule), is `pending`, not `login` — see "Preview: wait for
the connector token". The gate redirect cannot complete from the ephemeral
sandbox hostname (it resolves apps by hostname and lands on "App not found"),
so `callTool` never returns `loginRequired` in the preview; sign-in only
completes on the published hostname. On a **deployed** app a request without
any connector token did not come through the gate at all (the gate injects one
on every proxied request), so `missing_connector_token` is a plain `error`
with no `loginRequired` / `loginUrl`.

## Sign-in for connector apps: Grok only

When the app calls connector tools, the viewer identity is the **gate
session** — `callTool` runs as the viewer the gate authenticated, regardless
of who is signed into the app's own Better Auth. So:

- **Opened from Grok, the viewer is already signed in.** The gate
  authenticates with zero clicks (deployed apps with sign-in on materialize
  the session from `x-grok-identity` — see `auth/references/grok-identity.md`)
  and injects a fresh connector token on every proxied request. **There is no
  re-auth concept**: never render a standing "Re-auth with Grok" /
  "Sign in again" / "Refresh session" / "Continue with Grok" button, and never
  show any sign-in CTA while connector calls are succeeding.
- **The only sign-in surface is the `login` error state.** Write that
  signed-out state first: render the "Continue with Grok" button only when a
  connector call actually returned `loginRequired: true`, and call
  `redirectToLoginIfRequired(res)` only inside that button's click handler.
  That is the whole sign-in flow — there is no on-load redirect to write (one
  blanks the preview), so the first draft never contains
  `redirectToLoginIfRequired` outside a user gesture. The gate-built
  `res.loginUrl` is the only sign-in URL; never construct one yourself.
- **Do not render Google / X provider buttons** on a connector app's login
  surface, and never treat the app's own Better-Auth social login as the
  viewer identity for connector calls — the gate token identifies the viewer,
  not the Better Auth session.
- **If the app also has its own accounts feature**, mind the identity
  mismatch: a broker Google/X login can mint a Better Auth user that is NOT
  the gate viewer, so per-user rows and connector data can belong to two
  different people. Rely on the pre-wired zero-click gate session instead of
  offering a separate social login.

## Auth (server request only)

| Piece | Role |
| --- | --- |
| Gate → Vercel | Injects `x-connector-access-token` on the request into the app |
| App backend SDK | Reads that header; POSTs to the connectors host (no cookies forwarded) |
| Gate → connectors | Verifies JWT; runs CallTool as the **viewer** |

No app client secret. No browser-held connector token.

## Env

| Var | Required | Purpose |
| --- | --- | --- |
| `GROK_CONNECTORS_URL` | platform-managed | Connectors base URL; injected by the sandbox (preview) and the deployer (published). Do not set or override it in app code |
| `GROK_CONNECTOR_ACCESS_TOKEN` | optional | Offline tests / workspace preview only; ignored when `NODE_ENV=production` — never `VITE_*` |

Host sniffing from `x-forwarded-host` remains only as a fallback for older
deployments without the injected env.

## Integers

Pass plain numbers (`max_results: 50`). Wire format is protobuf Struct, but
the connectors host coerces whole-number floats back to integers, so do not
stringify integer args.

## Self-check before you finish

- [ ] Tool names came from grant-scoped discovery (`GatewayListTools` +
      `project_id`), not guessed — never `google_calendar_list_events`
- [ ] Every MCP tool name is byte-for-byte a discovered name (bare remote or
      `<server>___<remote>`) — nothing composed from catalog/capability words
- [ ] Every connector type the app calls is declared in `deploy.connectors` in
      `.grok/app-env.json` (merged — `VITE_*` and `deploy.database` intact)
- [ ] Every declared MCP catalog name is the connector's exact Grok display
      name, and grant-scoped discovery returned its tools after the owner
      granted — if the connector never became grantable, the integration was
      stopped and the user told, not shipped on agent-side tool access
- [ ] No seeded/mock rows presented as the viewer's real connector data —
      empty and error states render explicitly (demo data only if labeled
      "Sample data")
- [ ] Connector-backed views fetch live via the server function, not from a
      DB mirror
- [ ] Every `callTool` passes an explicit `connectorType` from the app's grant
- [ ] Every connector server function uses `createServerFn({ method: "POST" })`
- [ ] Server functions return the whole `CallToolResult` (no stripping `loginRequired` / `loginUrl` / `pending`)
- [ ] No `callTool` outside a server handler
- [ ] No browser `fetch` to the connectors host
- [ ] UI only invokes `createServerFn` exports
- [ ] No connector tokens in client state or `VITE_*` env
- [ ] Result parsing tolerates missing keys / snake_case + camelCase
- [ ] Parser shaped against a REAL response sampled through the app's own
      `callTool` path (never the agent-side tool envelope); MCP text content
      blocks JSON.parsed when present
- [ ] No row dropped for lacking a field the server was never observed to
      send — unobserved fields optional, missing keys derived, partial rows
      rendered
- [ ] `not_connected` / `scope_denied` render a friendly state, not a crash
- [ ] Error states come from `classifyCallToolError` (no hand-rolled
      `errorMessage` matching) and render `detail` as secondary text
- [ ] No sign-in CTA on any data-error kind (`not_connected` / `scope_denied` /
      `access_denied` / `error`), and no raw SDK error string as the visible
      message
- [ ] Every connector view wires `useRefetchWhenConnectorReady` and renders
      `kind: "pending"` as a loading state ("Connecting to <connector>…") —
      never "unavailable" / "reload" / a button the user must press to get
      their data the first time; `"not_embedded"` renders "Open this app from
      Grok to load your data."
- [ ] `loginRequired` handled in the browser via `redirectToLoginIfRequired(res)`
- [ ] Login surface offers only "Continue with Grok" (gate session /
      `res.loginUrl`) — no Google/X provider buttons, and the app's own
      Better-Auth social login is never the identity for connector calls
- [ ] No standing sign-in / re-auth / "Continue with Grok" button outside the
      `login` error state — nothing auth-related renders while calls succeed
- [ ] No automatic refetch on `ok: false` — failure renders a terminal error
      state with a manual "Try again" action, and skeletons are keyed off
      "in flight", never off "no successful data yet"
- [ ] Fetches fire once on mount + explicit Refresh only — no polling or
      effect-refetch loops; manual refresh keeps previous data visible
      (button spinner, no skeleton re-flash)
- [ ] The signed-out (`login`) state renders a "Continue with Grok" button and
      `redirectToLoginIfRequired(res)` runs only in its click handler — no
      sign-in redirect anywhere in initial render
