#!/usr/bin/env node
/**
 * LinkedIn Ads MCP Server - Streamable HTTP Transport for Google Cloud Deployment
 *
 * Uses the MCP Streamable HTTP transport, compatible with claude.ai connectors
 * and Claude Desktop. Supports multiple concurrent team members.
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
import { TokenStore } from './auth/token-store.js';
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

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Optional API key auth
const API_KEY = process.env.MCP_API_KEY;
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if (!API_KEY) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  if (authHeader.substring(7) !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
};

// Shared resources
const tokenStore = new TokenStore();
const apiClient = new LinkedInApiClient(tokenStore);

function createMCPServer(): Server {
  const server = new Server(
    { name: 'linkedin-ads-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const isAuthenticated = await tokenStore.hasValidToken();
    if (!isAuthenticated) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Not authenticated with LinkedIn. Please contact the administrator.' }) }],
        isError: true,
      };
    }

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

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', service: 'linkedin-ads-mcp', version: '1.0.0', transport: 'streamable-http' });
});

// MCP endpoint - stateless, one transport per request
app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMCPServer();
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
  console.log(`Auth:   ${API_KEY ? 'ENABLED' : 'DISABLED'}`);
});
