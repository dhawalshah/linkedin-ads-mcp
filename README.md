# LinkedIn Ads MCP

A Model Context Protocol (MCP) server for LinkedIn Ads. Connect Claude (or any MCP-compatible AI client) directly to your LinkedIn ad accounts to query performance, manage campaigns, analyse audiences, and search the public Ad Library — all in natural language.

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

## Prerequisites

- Node.js 18+
- A [LinkedIn Developer App](https://www.linkedin.com/developers/apps) with the following products added:
  - **Advertising API** (for ad account access)
  - **LinkedIn Ad Library** (optional — only needed for `search_ad_library`)

---

## Step 1: Create a LinkedIn Developer App

1. Go to [https://www.linkedin.com/developers/apps/new](https://www.linkedin.com/developers/apps/new)
2. Fill in App Name, LinkedIn Page, and App Logo, then click **Create app**
3. Under the **Products** tab, request access to:
   - **Advertising API** — click **Request access** and follow the prompts
   - **LinkedIn Ad Library** — click **Request access** (approval is usually instant)
4. Once approved, go to the **Auth** tab and note your **Client ID** and **Client Secret**
5. Under **Authorized redirect URLs**, add: `http://localhost:3000/callback`

> **Ad account access:** Your LinkedIn account must have at least **Campaign Manager** access on the ad accounts you want to query. The MCP will only return accounts your authenticated user can see.

---

## Step 2: Local Setup

```bash
git clone https://github.com/your-org/linkedin-ads-mcp
cd linkedin-ads-mcp
npm install
```

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
LINKEDIN_CLIENT_ID=your_client_id_here
LINKEDIN_CLIENT_SECRET=your_client_secret_here
LINKEDIN_REDIRECT_URI=http://localhost:3000/callback
```

Build the project:

```bash
npm run build
```

---

## Step 3: Authenticate with LinkedIn

Run the OAuth flow. This opens your browser to authorise the app:

```bash
npm run auth
```

Follow the browser prompts. On success, tokens are saved to `~/.linkedin-ads-mcp/tokens.json`.

> Tokens are valid for ~60 days and auto-refresh silently. The refresh token lasts ~365 days — you'll only need to re-run `npm run auth` once a year.

---

## Usage Options

### Option A: Local (Claude Desktop — single user)

Add to your Claude Desktop config at `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "linkedin-ads": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-ads-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop.

---

### Option B: Hosted Server (Claude Desktop or claude.ai — shared team access)

Run a persistent HTTP server that your whole team connects to. One person authenticates; everyone uses the same server.

**Start the server:**

```bash
node dist/server-sse.js
```

The server runs on port 8080 by default. Health check: `http://localhost:8080/health`

**Connect via Claude Desktop** (add to `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "linkedin-ads": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

**Secure with an API key** (recommended for shared/remote servers):

Set `MCP_API_KEY=your-secret-key` in your environment, then connect with:

```json
{
  "mcpServers": {
    "linkedin-ads": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-key"
      }
    }
  }
}
```

---

### Option C: Deploy to Google Cloud Run (recommended for teams)

One deployment, always-on, everyone connects via a shared URL.

**Prerequisites:** [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated.

**1. Get your tokens JSON** (after running `npm run auth`):

```bash
cat ~/.linkedin-ads-mcp/tokens.json
```

**2. Create an env vars file:**

```yaml
# /tmp/li-ads-mcp-env.yaml
LINKEDIN_CLIENT_ID: "your_client_id"
LINKEDIN_CLIENT_SECRET: "your_client_secret"
LINKEDIN_TOKENS_JSON: '{"access_token":"...","refresh_token":"...","expires_in":5183999,"expires_at":1234567890}'
MCP_API_KEY: "your-secret-key"
```

Paste the full contents of `tokens.json` as a single line for `LINKEDIN_TOKENS_JSON`.

**3. Deploy:**

```bash
gcloud run deploy linkedin-ads-mcp \
  --source . \
  --region YOUR_REGION \
  --project YOUR_PROJECT_ID \
  --platform managed \
  --port 8080 \
  --allow-unauthenticated \
  --env-vars-file /tmp/li-ads-mcp-env.yaml
```

Replace `YOUR_REGION` (e.g. `asia-southeast1`) and `YOUR_PROJECT_ID`.

**4. Connect team members via Claude Desktop:**

```json
{
  "mcpServers": {
    "linkedin-ads": {
      "url": "https://YOUR-SERVICE-URL.run.app/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-key"
      }
    }
  }
}
```

> **Token refresh on Cloud Run:** The Cloud Run filesystem is ephemeral. On container restart, the server reloads tokens from `LINKEDIN_TOKENS_JSON` and auto-refreshes the access token if expired — as long as the refresh token (~365 days) is still valid. Once a year, re-run `npm run auth` locally and redeploy with the updated `LINKEDIN_TOKENS_JSON`.

---

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `LINKEDIN_CLIENT_ID` | Yes | OAuth app client ID |
| `LINKEDIN_CLIENT_SECRET` | Yes | OAuth app client secret |
| `LINKEDIN_REDIRECT_URI` | No | OAuth callback URL (default: `http://localhost:3000/callback`) |
| `TOKEN_STORAGE_PATH` | No | Custom path for token file (default: `~/.linkedin-ads-mcp/tokens.json`) |
| `LINKEDIN_TOKENS_JSON` | No | JSON-encoded token object — used instead of token file (for cloud deployments) |
| `MCP_API_KEY` | No | Bearer token to protect the HTTP server endpoint |
| `PORT` | No | HTTP server port (default: `8080`) |

---

## Available Tools

| Tool | Description |
| --- | --- |
| `list_ad_accounts` | List all LinkedIn ad accounts accessible to the authenticated user |
| `get_account_details` | Get details for a specific ad account |
| `get_campaign_performance` | Get performance metrics for campaigns |
| `get_creative_performance` | Get performance metrics for creatives |
| `get_campaign_groups` | List campaign groups |
| `list_campaigns` | List campaigns in an account |
| `get_audience_demographics` | Get demographic breakdown of campaign audiences |
| `get_audience_reach` | Get estimated audience reach |
| `list_saved_audiences` | List saved audience segments |
| `get_conversion_performance` | Get conversion tracking metrics |
| `list_conversions` | List conversion events |
| `get_lead_gen_performance` | Get lead gen form performance |
| `list_lead_forms` | List lead gen forms |
| `compare_performance` | Compare performance across two date ranges |
| `get_daily_trends` | Get day-by-day performance data |
| `create_campaign_group` | Create a new campaign group |
| `update_campaign_group` | Update an existing campaign group |
| `delete_campaign_group` | Delete a campaign group |
| `create_campaign` | Create a new campaign |
| `update_campaign` | Update an existing campaign |
| `delete_campaign` | Delete a campaign |
| `create_creative` | Create a new creative |
| `create_inline_ad` | Create a sponsored content ad |
| `update_creative_status` | Pause or activate a creative |
| `upload_image` | Upload an image for use in ads |
| `search_ad_library` | Search LinkedIn's public Ad Library (requires Ad Library product) |

---

## Example Prompts

```text
Show me the performance of all campaigns in the last 30 days

Which creatives had the best CTR last quarter?

Compare campaign performance between Q1 and Q2

Search the LinkedIn Ad Library for Salesforce ads targeting engineers in the US

What audiences is HubSpot targeting in Singapore?

Create a new campaign group called "Brand Awareness 2025" with a $10,000 monthly budget
```

---

## Re-authenticating

If your refresh token expires (~1 year), re-run the auth flow:

```bash
npm run auth
```

For Cloud Run deployments, update `LINKEDIN_TOKENS_JSON` and redeploy:

```bash
# Get fresh tokens after re-authenticating
TOKENS=$(cat ~/.linkedin-ads-mcp/tokens.json | tr -d '\n')

# Update your env vars file with the new token value, then redeploy
gcloud run deploy linkedin-ads-mcp \
  --source . \
  --region YOUR_REGION \
  --project YOUR_PROJECT_ID \
  --env-vars-file /tmp/li-ads-mcp-env.yaml
```

---

## Attribution

Based on [linkedin-ads-mcp](https://github.com/danielpopamd/linkedin-ads-mcp) by [Daniel Popa](https://danielpopa.me), with additional features including Streamable HTTP transport for remote team deployments and LinkedIn Ad Library search support.

---

## License

MIT
