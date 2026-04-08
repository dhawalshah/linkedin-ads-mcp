import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { LinkedInApiClient } from '../lib/linkedin-api.js';

const TARGETING_FACET_CATEGORIES = ['LANGUAGE', 'LOCATION', 'AUDIENCE', 'AGE', 'GENDER', 'COMPANY', 'EDUCATION', 'JOB', 'INTERESTS', 'TRAITS'] as const;

// LinkedIn Ad Library historical data starts from this date
const AD_LIBRARY_DATA_START = { day: 1, month: 6, year: 2023 };

export const searchAdLibraryTool: Tool = {
  name: 'search_ad_library',
  description:
    'Search the LinkedIn Ad Library for public ads from any advertiser. ' +
    'Useful for competitive research, creative inspiration, and transparency. ' +
    'Returns ad previews, targeting info, impression ranges, and advertiser details.',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: 'Keyword to search within ad content (multiple keywords use AND logic)',
      },
      advertiser: {
        type: 'string',
        description: 'Advertiser name to filter by (partial match supported)',
      },
      payerName: {
        type: 'string',
        description: 'Name of the entity paying/sponsoring the ad',
      },
      countries: {
        type: 'array',
        items: { type: 'string' },
        description: 'ISO 3166-1 alpha-2 country codes to filter by (e.g. ["US", "GB", "SG"])',
      },
      dateRangeStart: {
        type: 'object',
        description: 'Start date (inclusive)',
        properties: {
          day: { type: 'number' },
          month: { type: 'number' },
          year: { type: 'number' },
        },
        required: ['day', 'month', 'year'],
      },
      dateRangeEnd: {
        type: 'object',
        description: 'End date (exclusive). Defaults to yesterday if not provided.',
        properties: {
          day: { type: 'number' },
          month: { type: 'number' },
          year: { type: 'number' },
        },
        required: ['day', 'month', 'year'],
      },
      includedTargetingCategories: {
        type: 'array',
        items: { type: 'string', enum: TARGETING_FACET_CATEGORIES },
        description: 'Only return ads that use these targeting facet categories',
      },
      excludedTargetingCategories: {
        type: 'array',
        items: { type: 'string', enum: TARGETING_FACET_CATEGORIES },
        description: 'Exclude ads that use these targeting facet categories',
      },
      minImpressions: {
        type: 'number',
        description: 'Minimum total impressions filter',
      },
      maxImpressions: {
        type: 'number',
        description: 'Maximum total impressions filter',
      },
      sortOrder: {
        type: 'string',
        enum: ['ASCENDING', 'DESCENDING'],
        description: 'Sort by created time. Defaults to DESCENDING (newest first).',
      },
      start: {
        type: 'number',
        description: 'Pagination offset (default 0)',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (max 25, default 10)',
      },
    },
  },
};

export async function handleSearchAdLibrary(
  apiClient: LinkedInApiClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const options: Parameters<LinkedInApiClient['searchAdLibrary']>[0] = {
    start: (args.start as number) || 0,
    count: (args.count as number) || 10,
  };

  if (args.keyword) options.keyword = args.keyword as string;
  if (args.advertiser) options.advertiser = args.advertiser as string;
  if (args.payerName) options.payerName = args.payerName as string;
  if (args.countries) options.countries = args.countries as string[];
  if (args.includedTargetingCategories) options.includedTargetingFacetCategories = args.includedTargetingCategories as string[];
  if (args.excludedTargetingCategories) options.excludedTargetingFacetCategories = args.excludedTargetingCategories as string[];
  if (args.sortOrder) {
    options.sortByField = 'CREATED_TIME';
    options.sortByOrder = args.sortOrder as 'ASCENDING' | 'DESCENDING';
  }

  if (args.dateRangeStart || args.dateRangeEnd) {
    const start = (args.dateRangeStart as { day: number; month: number; year: number }) ?? AD_LIBRARY_DATA_START;
    const end = (args.dateRangeEnd as { day: number; month: number; year: number }) ?? (() => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      return { day: yesterday.getDate(), month: yesterday.getMonth() + 1, year: yesterday.getFullYear() };
    })();
    options.dateRange = { start, end };
  }

  if (args.minImpressions !== undefined || args.maxImpressions !== undefined) {
    options.totalImpressionsRange = {
      from: args.minImpressions as number | undefined,
      to: args.maxImpressions as number | undefined,
    };
  }

  const result = await apiClient.searchAdLibrary(options);
  return {
    totalResults: (result.paging as Record<string, unknown>)?.total,
    count: result.elements.length,
    ads: result.elements,
  };
}
