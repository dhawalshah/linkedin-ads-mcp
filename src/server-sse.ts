#!/usr/bin/env node
/**
 * LinkedIn Ads MCP — HTTP server (Cloud Run).
 *
 * The /mcp endpoint is an OAuth 2.1 protected resource. The server also acts
 * as the authorization server for it (see ./auth/oauth-server.ts), proxying
 * user authentication to LinkedIn.
 *
 * Auth flow for MCP clients (Claude, etc.):
 *
 *   1. Client GETs /mcp without a token → 401 + WWW-Authenticate
 *   2. Client follows the protected-resource metadata link, registers with
 *      the authorization server (Dynamic Client Registration), and runs the
 *      OAuth 2.1 authorization code flow with PKCE.
 *   3. Client receives an opaque bearer issued by this server and includes
 *      it on every /mcp request.
 *   4. Middleware here validates the bearer, looks up the user's stored
 *      LinkedIn credentials, and builds a per-request LinkedInApiClient.
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { LinkedInApiClient } from './lib/linkedin-api.js';
import { UserScopedTokenProvider } from './auth/firestore-store.js';
import { oauthRouter, resolveBearer } from './auth/oauth-server.js';
import {
  listAdAccountsTool,
  getAccountDetailsTool,
  handleListAdAccounts,
  handleGetAccountDetails,
} from './tools/accounts.js';
import {
  getCampaignPerformanceTool,
  getCreativePerformanceTool,
  getCampaignGroupsTool,
  handleGetCampaignPerformance,
  handleGetCreativePerformance,
  handleGetCampaignGroups,
} from './tools/performance.js';
import {
  getAudienceDemographicsTool,
  getAudienceReachTool,
  listSavedAudiencesTool,
  handleGetAudienceDemographics,
  handleGetAudienceReach,
  handleListSavedAudiences,
} from './tools/demographics.js';
import {
  getConversionPerformanceTool,
  listConversionsTool,
  getLeadGenPerformanceTool,
  listLeadFormsTool,
  handleGetConversionPerformance,
  handleListConversions,
  handleGetLeadGenPerformance,
  handleListLeadForms,
} from './tools/conversions.js';
import {
  comparePerformanceTool,
  getDailyTrendsTool,
  handleComparePerformance,
  handleGetDailyTrends,
} from './tools/analytics.js';
import { searchAdLibraryTool, handleSearchAdLibrary } from './tools/ad-library.js';
import {
  createCampaignGroupTool,
  updateCampaignGroupTool,
  deleteCampaignGroupTool,
  createCampaignTool,
  updateCampaignTool,
  deleteCampaignTool,
  updateCreativeStatusTool,
  createCreativeTool,
  handleCreateCampaignGroup,
  handleUpdateCampaignGroup,
  handleDeleteCampaignGroup,
  handleCreateCampaign,
  handleUpdateCampaign,
  handleDeleteCampaign,
  handleUpdateCreativeStatus,
  handleCreateCreative,
  createInlineAdTool,
  handleCreateInlineAd,
  listCampaignsTool,
  handleListCampaigns,
  uploadImageTool,
  handleUploadImage,
} from './tools/campaign-management.js';

const TOOLS: Tool[] = [
  listAdAccountsTool,
  getAccountDetailsTool,
  getCampaignPerformanceTool,
  getCreativePerformanceTool,
  getCampaignGroupsTool,
  getAudienceDemographicsTool,
  getAudienceReachTool,
  listSavedAudiencesTool,
  getConversionPerformanceTool,
  listConversionsTool,
  getLeadGenPerformanceTool,
  listLeadFormsTool,
  comparePerformanceTool,
  getDailyTrendsTool,
  createCampaignGroupTool,
  updateCampaignGroupTool,
  deleteCampaignGroupTool,
  createCampaignTool,
  updateCampaignTool,
  deleteCampaignTool,
  updateCreativeStatusTool,
  createCreativeTool,
  createInlineAdTool,
  listCampaignsTool,
  uploadImageTool,
  searchAdLibraryTool,
];

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // /oauth/token uses form-encoded

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// OAuth 2.1 authorization server endpoints
app.use(oauthRouter);

function baseUrl(): string {
  return (process.env.BASE_URL || '').replace(/\/$/, '');
}

// Service info / health
app.get('/', (_req: Request, res: Response) => {
  const base = baseUrl();
  res.json({
    name: 'LinkedIn Ads MCP',
    mcp_endpoint: base ? `${base}/mcp` : '/mcp',
    protected_resource_metadata: `${base}/.well-known/oauth-protected-resource`,
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', service: 'linkedin-ads-mcp', transport: 'streamable-http' });
});

// 401 with WWW-Authenticate per RFC 9728
function unauthorized(res: Response): void {
  const metadataUrl = `${baseUrl()}/.well-known/oauth-protected-resource`;
  res.set(
    'WWW-Authenticate',
    `Bearer realm="mcp", resource_metadata="${metadataUrl}", error="invalid_token"`
  );
  res.status(401).json({ error: 'unauthorized' });
}

function createMCPServer(apiClient: LinkedInApiClient): Server {
  const server = new Server(
    { name: 'linkedin-ads-mcp', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: unknown;
      switch (name) {
        case 'list_ad_accounts':       result = await handleListAdAccounts(apiClient, args); break;
        case 'get_account_details':    result = await handleGetAccountDetails(apiClient, args); break;
        case 'get_campaign_performance': result = await handleGetCampaignPerformance(apiClient, args); break;
        case 'get_creative_performance': result = await handleGetCreativePerformance(apiClient, args); break;
        case 'get_campaign_groups':    result = await handleGetCampaignGroups(apiClient, args); break;
        case 'get_audience_demographics': result = await handleGetAudienceDemographics(apiClient, args); break;
        case 'get_audience_reach':     result = await handleGetAudienceReach(apiClient, args); break;
        case 'list_saved_audiences':   result = await handleListSavedAudiences(apiClient, args); break;
        case 'get_conversion_performance': result = await handleGetConversionPerformance(apiClient, args); break;
        case 'list_conversions':       result = await handleListConversions(apiClient, args); break;
        case 'get_lead_gen_performance': result = await handleGetLeadGenPerformance(apiClient, args); break;
        case 'list_lead_forms':        result = await handleListLeadForms(apiClient, args); break;
        case 'compare_performance':    result = await handleComparePerformance(apiClient, args); break;
        case 'get_daily_trends':       result = await handleGetDailyTrends(apiClient, args); break;
        case 'create_campaign_group':  result = await handleCreateCampaignGroup(apiClient, args); break;
        case 'update_campaign_group':  result = await handleUpdateCampaignGroup(apiClient, args); break;
        case 'delete_campaign_group':  result = await handleDeleteCampaignGroup(apiClient, args); break;
        case 'create_campaign':        result = await handleCreateCampaign(apiClient, args); break;
        case 'update_campaign':        result = await handleUpdateCampaign(apiClient, args); break;
        case 'delete_campaign':        result = await handleDeleteCampaign(apiClient, args); break;
        case 'update_creative_status': result = await handleUpdateCreativeStatus(apiClient, args); break;
        case 'create_creative':        result = await handleCreateCreative(apiClient, args); break;
        case 'create_inline_ad':       result = await handleCreateInlineAd(apiClient, args); break;
        case 'list_campaigns':         result = await handleListCampaigns(apiClient, args); break;
        case 'upload_image':           result = await handleUploadImage(apiClient, args); break;
        case 'search_ad_library':      result = await handleSearchAdLibrary(apiClient, args || {}); break;
        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error handling tool ${name}:`, errorMessage);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errorMessage }) }],
        isError: true,
      };
    }
  });

  return server;
}

// /mcp endpoint — OAuth-protected resource
app.all('/mcp', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return unauthorized(res);
  }
  const accessToken = auth.slice(7).trim();
  const record = await resolveBearer(accessToken);
  if (!record) return unauthorized(res);

  const tokenProvider = new UserScopedTokenProvider(record.user_email);
  const liToken = await tokenProvider.getAccessToken();
  if (!liToken) {
    // The user's stored LinkedIn credentials are missing or unrefreshable.
    // Force the client to re-run the OAuth flow.
    return unauthorized(res);
  }

  const apiClient = new LinkedInApiClient(tokenProvider);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMCPServer(apiClient);
  const cleanup = () => server.close();
  res.on('finish', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LinkedIn Ads MCP Server running on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
  console.log(`MCP:    http://0.0.0.0:${PORT}/mcp`);
});
