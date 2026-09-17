# LinkedIn Ads MCP

A Model Context Protocol (MCP) server for LinkedIn Ads. Connect Claude (or any MCP-compatible AI client) directly to your LinkedIn ad accounts to query performance, manage campaigns, analyse audiences, and search the public Ad Library — all in natural language.

The server speaks the [MCP authorization spec (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), so it works as a remote connector anywhere Claude supports custom MCP servers — claude.ai (personal), Claude Desktop, and Claude Teams. Add **one URL**, click "Connect", sign in with LinkedIn, done. For a Teams plan, the org owner adds the URL once and each member individually authenticates on first use.

## What you can do

### Account & Campaign Management
- List and inspect ad accounts
- Create, update, and delete campaign groups and campaigns
- Manage creatives and update their status
- Upload images and create inline ads

### Performance & Analytics
- Get campaign and creative performance metrics
- Compare performance across date ranges
- View daily trends
- Analyse audience demographics and reach

### Conversions & Lead Gen
- Track conversion performance
- View lead gen form submissions and performance

### Ad Library (Public)
- Search any advertiser's public LinkedIn ads
- Filter by country, date range, targeting categories, impression volume
- Useful for competitive research and creative inspiration

---

## How auth works

There are **two** modes. Pick one.

### Mode A — Local STDIO (one user, no server)
Use this if you only want it on your own machine. `npm run auth` runs the LinkedIn OAuth flow once and stores your token in `~/.linkedin-ads-mcp/tokens.json`. Claude Desktop launches the server as a subprocess. No Firestore, no Cloud Run, no public URL.

### Mode B — Remote HTTP server (Claude Teams, claude.ai, multi-user)
The MCP server is also an OAuth 2.1 authorization server. When Claude connects:

1. Claude discovers our metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
2. Claude registers itself via Dynamic Client Registration (`POST /oauth/register`).
3. Claude redirects the user to `/oauth/authorize`. We delegate identification to LinkedIn OAuth.
4. After LinkedIn login, we issue our **own** opaque bearer token to Claude — LinkedIn credentials never leave the server.
5. On each `/mcp` request Claude sends our bearer; we map it server-side to the right user's stored LinkedIn credentials and call the LinkedIn Marketing APIs.

> **A note on access control.** LinkedIn returns whatever email the account was registered with — usually personal (gmail, hotmail, etc.) rather than work email. Domain-based restriction therefore isn't reliable. By default this MCP allows any LinkedIn user to connect; the security comes from LinkedIn's own permission model (each user only sees ad accounts their LinkedIn profile has access to). For tighter control, set `ALLOWED_EMAILS` to a comma-separated allow-list of LinkedIn-account emails.

---

## Prerequisites

- Node.js 18+
- A LinkedIn Marketing Developer Platform-approved app
- A [Google Cloud](https://console.cloud.google.com/) project (Mode B only)

---

## Step 1 — Create a LinkedIn Developer App

1. Go to [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) and create an app (or use an existing one).
2. Under **Products**, request:
   - **Sign In with LinkedIn using OpenID Connect** (gives `openid email` for user identification)
   - **Marketing Developer Platform** (gives `r_ads`, `r_ads_reporting`, `rw_ads`, `r_organization_social`, `w_organization_social` — required for the ads tools; access requires LinkedIn approval)
3. Under **Auth → OAuth 2.0 settings → Authorized redirect URLs**, add:
   - `http://localhost:8080/oauth/callback` *(local dev)*
   - `https://YOUR-CLOUD-RUN-URL/oauth/callback` *(Mode B — add after deploy)*
4. Copy the **Client ID** and **Client Secret** — you'll need them in the env config below.

---

## Step 2 — Install

```bash
git clone https://github.com/dhawalshah/linkedin-ads-mcp
cd linkedin-ads-mcp
npm install
cp .env.example .env       # fill in values
```

---

## Step 3 — Mode A: Local STDIO

```bash
npm run auth     # one-shot browser sign-in; saves token to ~/.linkedin-ads-mcp/tokens.json
npm run build
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "linkedin-ads": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-ads-mcp/dist/index.js"],
      "env": {
        "LINKEDIN_CLIENT_ID": "your_client_id",
        "LINKEDIN_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

Restart Claude Desktop. You're done — skip the rest.

---

## Step 3 — Mode B: Remote HTTP server (Claude Teams / claude.ai)

### Enable Firestore
The server stores OAuth bearer tokens and per-user LinkedIn credentials in Firestore.
1. In Cloud Console, **Firestore → Create database → Native mode**, pick a region.
2. Grant the Cloud Run service account **Cloud Datastore User** role under **IAM & Admin → IAM**.

### Deploy to Cloud Run

```bash
gcloud run deploy linkedin-ads-mcp \
  --source . \
  --region YOUR_REGION \
  --project YOUR_PROJECT_ID \
  --platform managed \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars "GCP_PROJECT_ID=your-project-id,BASE_URL=https://YOUR-SERVICE-URL.run.app,LINKEDIN_CLIENT_ID=...,LINKEDIN_CLIENT_SECRET=..."
```

> **Recommended:** store `LINKEDIN_CLIENT_SECRET` in Secret Manager and inject via `--set-secrets` rather than as a plain env var.

After it's up, go back to the LinkedIn Developer Portal and add the live callback URL:

```
https://YOUR-SERVICE-URL.run.app/oauth/callback
```

### Connect from Claude

**Claude Teams (org owner adds it once for everyone):**
- Settings → Connectors → Add custom connector
- URL: `https://YOUR-SERVICE-URL.run.app/mcp`
- Each member clicks **Connect**, signs in with LinkedIn, done.

**claude.ai personal:**
- Settings → Connectors → Add custom connector
- URL: `https://YOUR-SERVICE-URL.run.app/mcp`

**Claude Desktop with a remote server:**
```json
{
  "mcpServers": {
    "linkedin-ads": {
      "url": "https://YOUR-SERVICE-URL.run.app/mcp"
    }
  }
}
```
Claude Desktop will run the OAuth dance the first time you use it.

---

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `LINKEDIN_CLIENT_ID` | Yes | OAuth client ID from your LinkedIn app. |
| `LINKEDIN_CLIENT_SECRET` | Yes | OAuth client secret from your LinkedIn app. |
| `LINKEDIN_REDIRECT_URI` | No | Override the LinkedIn callback URL. Defaults to `${BASE_URL}/oauth/callback`. |
| `BASE_URL` | Mode B | Public URL of this service. Used for OAuth metadata and as the canonical resource URI tokens are bound to. |
| `GCP_PROJECT_ID` | Mode B | GCP project hosting Firestore. |
| `ALLOWED_EMAILS` | No | Comma-separated allow-list of LinkedIn-account emails. Empty = no restriction. |
| `TOKEN_STORAGE_PATH` | Mode A | Override the local token file path. Defaults to `~/.linkedin-ads-mcp/tokens.json`. |
| `LINKEDIN_TOKENS_JSON` | Mode A | Inline JSON to seed local tokens (overrides the file). |
| `PORT` | No | HTTP port (default `8080`). |

---

## Available Tools

### Account & Campaign Management

| Tool | Description |
| --- | --- |
| `list_ad_accounts` | List all accessible LinkedIn ad accounts |
| `get_account_details` | Account name, currency, status, and serving status |
| `list_campaigns` | List campaigns for an account |
| `get_campaign_groups` | List campaign groups |
| `create_campaign_group` / `update_campaign_group` / `delete_campaign_group` | Manage campaign groups |
| `create_campaign` / `update_campaign` / `delete_campaign` | Manage campaigns |
| `create_creative` / `update_creative_status` | Manage creatives |
| `create_inline_ad` | One-shot creative + campaign creation |
| `upload_image` | Upload an image asset for use in creatives |

### Performance & Analytics

| Tool | Description |
| --- | --- |
| `get_campaign_performance` | Impressions, clicks, cost, CTR, CPC, conversions per campaign |
| `get_creative_performance` | Performance metrics broken down by creative, including engagement and video metrics |
| `compare_performance` | Side-by-side comparison of two date ranges |
| `get_daily_trends` | Daily performance trend data |

### Audience & Demographics

| Tool | Description |
| --- | --- |
| `get_audience_demographics` | Performance breakdown by demographic pivot (industry, seniority, function, etc.) |
| `get_audience_reach` | Reach and impression counts across an audience |
| `list_saved_audiences` | List saved targeting audiences |

### Conversions & Lead Gen

| Tool | Description |
| --- | --- |
| `list_conversions` | All configured conversion actions |
| `get_conversion_performance` | Conversion counts and value across campaigns |
| `list_lead_forms` | All Lead Gen forms on an account |
| `get_lead_gen_performance` | One-click leads, form opens, qualified leads |

### Ad Library (Public)

| Tool | Description |
| --- | --- |
| `search_ad_library` | Search any advertiser's public LinkedIn ads with filters |

---

## Example Prompts

```
List my LinkedIn ad accounts

Show campaign performance for the last 30 days

Compare last week vs the week before for account 12345

Which industries are clicking most on campaign X?

What did my top creative drive in conversions last month?

Search the LinkedIn Ad Library for ads from Stripe in the US in 2026
```

---

## OAuth endpoint reference (Mode B)

For developers who want to verify the implementation or write their own MCP client.

| Endpoint | Spec | Purpose |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | Advertises the canonical resource URI and authorization server. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Authorization server metadata. |
| `POST /oauth/register` | RFC 7591 | Dynamic Client Registration. |
| `GET /oauth/authorize` | OAuth 2.1 | Starts the auth code flow with PKCE; redirects to LinkedIn. |
| `GET /oauth/callback` | — | LinkedIn redirects here; we mint our authorization code and bounce back to the MCP client. |
| `POST /oauth/token` | OAuth 2.1 | Authorization code + refresh token grants. |

A `GET /mcp` without a valid bearer returns `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` header pointing at the protected-resource metadata document, which is how a standards-compliant MCP client discovers the rest.

> **PKCE caveat:** LinkedIn's OAuth implementation does not support PKCE on the upstream side, so PKCE is only enforced on the Claude → us channel. The us → LinkedIn channel uses a `state` parameter for CSRF protection.

---

## Tech Stack

- **TypeScript + Node 18+**
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** — MCP server framework
- **Express** — HTTP server
- **@google-cloud/firestore** — per-user token storage and OAuth-server state (Mode B)
- **Google Cloud Run** — Serverless hosting

---

## About Dhawal Shah

<img src="https://www.dhawalshah.net/images/illustrations/about-dhawal-shah.webp" alt="Caricature of Dhawal Shah" align="right" width="155">

I run a 40-plus person digital marketing agency out of Singapore, and I build the
automation my own teams use. This server is one of those tools rather than a weekend
project: it runs against live LinkedIn Ads accounts every week, which is why the
read-only surface is wide and the write surface is deliberately narrow.

Fourteen years building companies across Asia behind it. 5,000+ campaigns, 400+ brands,
30+ startups advised, and 300+ training sessions for teams including Sony, Toyota, DHL
and Interpol. I am also an Accredited Director with the Singapore Institute of Directors,
which in practice means I get asked what breaks, who is accountable and what it costs
before anyone asks what it can do.

I write up the routines and agents I actually run at [dhawalshah.net](https://www.dhawalshah.net/about/).

Worth reading alongside this repo: [Google Ads, Meta, LinkedIn &amp; TikTok MCPs for Claude: Agency Setup Guide](https://www.dhawalshah.net/article/ad-platform-mcp-claude/).

---

## License

MIT
