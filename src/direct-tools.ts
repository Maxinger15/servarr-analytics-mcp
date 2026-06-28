import * as z from "zod/v4";
import { clientFor } from "./client.js";
import { configuredApps } from "./config.js";
import { shapeResult } from "./response.js";
import { appOptionsSchema, commonOptionsSchema, idSchema } from "./schemas.js";
import type { AppName, CommonQueryOptions, CursorPayload, ToolDefinition } from "./types.js";

type AnyArgs = Record<string, any>;
const MEDIA_APPS: AppName[] = ["sonarr", "radarr"];
const SONARR_ONLY: AppName[] = ["sonarr"];

interface DirectToolSpec {
  name: string;
  title: string;
  description: string;
  path: string | ((args: AnyArgs) => string);
  method?: "GET" | "POST";
  app?: AppName | ((args: AnyArgs) => AppName);
  supportedApps?: AppName[];
  schema?: z.ZodType;
  query?: (args: AnyArgs) => Record<string, unknown>;
  filter?: (item: unknown, app: AppName) => boolean;
}

function appFromArgs(args: AnyArgs): AppName {
  return args.app as AppName;
}

function directTool(spec: DirectToolSpec): ToolDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.schema ?? appOptionsSchema,
    async handler(args, context) {
      const castArgs = args as AnyArgs;
      const app = typeof spec.app === "function" ? spec.app(castArgs) : spec.app ?? appFromArgs(castArgs);
      if (spec.supportedApps && !spec.supportedApps.includes(app)) {
        throw new Error(`${spec.name} is not supported for ${app}. Supported apps: ${spec.supportedApps.join(", ")}.`);
      }
      const path = typeof spec.path === "function" ? spec.path(castArgs) : spec.path;
      const query = spec.query?.(castArgs);
      const data = await clientFor(context.config, app).request(path, {
        method: spec.method ?? "GET",
        ...(query ? { query } : {})
      });
      const filteredData = spec.filter ? filterResponseItems(data, (item) => spec.filter?.(item, app) ?? true) : data;
      const nextOptions = {
        ...(castArgs as CommonQueryOptions),
        page: ((castArgs.page as number | undefined) ?? 1) + 1
      };
      const nextCursor = encodeCursor(app, path, nextOptions, nextPageQuery(query, nextOptions.page));
      return shapeResult(filteredData, castArgs as CommonQueryOptions, { app, endpoint: path, nextCursor });
    }
  };
}

const appReadTools: DirectToolSpec[] = [
  {
    name: "get_system_status",
    title: "Get System Status",
    description: "Return Servarr system status for one configured app.",
    path: "system/status"
  },
  {
    name: "get_app_config",
    title: "Get App Config",
    description: "Return host-level configuration for one configured app.",
    path: "config/host"
  },
  {
    name: "get_api_version",
    title: "Get API Version",
    description: "Return version details from system status for one configured app.",
    path: "system/status"
  },
  {
    name: "get_quality_profiles",
    title: "Get Quality Profiles",
    description: "List quality profiles.",
    path: "qualityprofile",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_quality_profile",
    title: "Get Quality Profile",
    description: "Return a single quality profile by id.",
    path: (args) => `qualityprofile/${args.id}`,
    schema: idSchema,
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_quality_definitions",
    title: "Get Quality Definitions",
    description: "List quality definitions.",
    path: "qualitydefinition",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_custom_formats",
    title: "Get Custom Formats",
    description: "List custom formats.",
    path: "customformat",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_language_profiles",
    title: "Get Language Profiles",
    description: "List language profiles when supported by the app.",
    path: "languageprofile",
    supportedApps: SONARR_ONLY
  },
  {
    name: "get_delay_profiles",
    title: "Get Delay Profiles",
    description: "List delay profiles.",
    path: "delayprofile",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_tags",
    title: "Get Tags",
    description: "List tags.",
    path: "tag"
  },
  {
    name: "get_root_folders",
    title: "Get Root Folders",
    description: "List root folders.",
    path: "rootfolder",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_download_clients",
    title: "Get Download Clients",
    description: "List download clients.",
    path: "downloadclient"
  },
  {
    name: "get_indexers",
    title: "Get Indexers",
    description: "List indexers.",
    path: "indexer"
  },
  {
    name: "get_notifications",
    title: "Get Notifications",
    description: "List notifications.",
    path: "notification"
  },
  {
    name: "get_metadata_profiles",
    title: "Get Metadata Profiles",
    description: "List metadata profiles when supported by the app.",
    path: "metadata",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_naming_config",
    title: "Get Naming Config",
    description: "Return naming configuration.",
    path: "config/naming",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_media_management_config",
    title: "Get Media Management Config",
    description: "Return media management configuration.",
    path: "config/mediamanagement",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_disk_space",
    title: "Get Disk Space",
    description: "Return disk space information.",
    path: "diskspace",
    supportedApps: MEDIA_APPS
  },
  {
    name: "get_health",
    title: "Get Health",
    description: "Return health messages.",
    path: "health"
  },
  {
    name: "get_history",
    title: "Get History",
    description: "Return history records with optional paging and date filters.",
    path: "history",
    query: historyQuery
  },
  {
    name: "get_grab_history",
    title: "Get Grab History",
    description: "Return grab history records.",
    path: "history",
    query: historyQuery,
    filter: historyEventFilter(["grabbed", "grab"])
  },
  {
    name: "get_import_history",
    title: "Get Import History",
    description: "Return import/download-folder-imported history records.",
    path: "history",
    query: historyQuery,
    filter: historyEventFilter(["downloadFolderImported", "movieFileImported", "episodeFileImported"])
  },
  {
    name: "get_failed_history",
    title: "Get Failed History",
    description: "Return failed history records.",
    path: "history",
    query: historyQuery,
    filter: historyEventFilter(["downloadFailed", "downloadFailedFinished"])
  },
  {
    name: "get_deleted_history",
    title: "Get Deleted History",
    description: "Return deleted history records.",
    path: "history",
    query: historyQuery,
    filter: (_item, app) => historyEventMatches(_item, app === "sonarr" ? ["episodeFileDeleted"] : ["movieFileDeleted"])
  },
  {
    name: "get_queue",
    title: "Get Queue",
    description: "Return queue records.",
    path: "queue",
    query: queueQuery
  },
  {
    name: "get_queue_details",
    title: "Get Queue Details",
    description: "Return detailed queue records.",
    path: "queue/details",
    query: queueQuery
  },
  {
    name: "get_blocklist",
    title: "Get Blocklist",
    description: "Return blocklist records.",
    path: "blocklist",
    query: historyQuery,
    supportedApps: MEDIA_APPS
  }
];

const radarrTools: DirectToolSpec[] = [
  {
    name: "radarr_get_movies",
    title: "Radarr Get Movies",
    description: "List Radarr movies.",
    app: "radarr",
    path: "movie",
    schema: commonOptionsSchema
  },
  {
    name: "radarr_get_movie",
    title: "Radarr Get Movie",
    description: "Return one Radarr movie by id.",
    app: "radarr",
    path: (args) => `movie/${args.id}`,
    schema: commonOptionsSchema.extend({ id: z.union([z.string(), z.number()]) })
  },
  {
    name: "radarr_get_movie_files",
    title: "Radarr Get Movie Files",
    description: "List movie files for a Radarr movie.",
    app: "radarr",
    path: "moviefile",
    schema: commonOptionsSchema.extend({ movieId: z.union([z.string(), z.number()]) }),
    query: (args) => ({ movieId: args.movieId })
  },
  {
    name: "radarr_get_missing",
    title: "Radarr Get Missing",
    description: "List missing Radarr movies.",
    app: "radarr",
    path: "wanted/missing",
    schema: commonOptionsSchema,
    query: historyQuery
  },
  {
    name: "radarr_get_cutoff_unmet",
    title: "Radarr Get Cutoff Unmet",
    description: "List Radarr movies that have not met cutoff.",
    app: "radarr",
    path: "wanted/cutoff",
    schema: commonOptionsSchema,
    query: historyQuery
  }
];

const sonarrTools: DirectToolSpec[] = [
  {
    name: "sonarr_get_series",
    title: "Sonarr Get Series",
    description: "List Sonarr series, or return one series when id is provided.",
    app: "sonarr",
    path: (args) => (args.id === undefined ? "series" : `series/${args.id}`),
    schema: commonOptionsSchema.extend({ id: z.union([z.string(), z.number()]).optional() })
  },
  {
    name: "sonarr_get_episodes",
    title: "Sonarr Get Episodes",
    description: "List episodes for a Sonarr series.",
    app: "sonarr",
    path: "episode",
    schema: commonOptionsSchema.extend({ seriesId: z.union([z.string(), z.number()]) }),
    query: (args) => ({ seriesId: args.seriesId })
  },
  {
    name: "sonarr_get_episode_files",
    title: "Sonarr Get Episode Files",
    description: "List episode files for a Sonarr series.",
    app: "sonarr",
    path: "episodefile",
    schema: commonOptionsSchema.extend({ seriesId: z.union([z.string(), z.number()]) }),
    query: (args) => ({ seriesId: args.seriesId })
  },
  {
    name: "sonarr_get_missing",
    title: "Sonarr Get Missing",
    description: "List missing Sonarr episodes.",
    app: "sonarr",
    path: "wanted/missing",
    schema: commonOptionsSchema,
    query: historyQuery
  },
  {
    name: "sonarr_get_cutoff_unmet",
    title: "Sonarr Get Cutoff Unmet",
    description: "List Sonarr episodes that have not met cutoff.",
    app: "sonarr",
    path: "wanted/cutoff",
    schema: commonOptionsSchema,
    query: historyQuery
  }
];

const prowlarrTools: DirectToolSpec[] = [
  {
    name: "get_indexer",
    title: "Get Prowlarr Indexer",
    description: "Return one Prowlarr indexer by id.",
    app: "prowlarr",
    path: (args) => `indexer/${args.id}`,
    schema: commonOptionsSchema.extend({ id: z.union([z.string(), z.number()]) })
  },
  {
    name: "get_indexer_status",
    title: "Get Prowlarr Indexer Status",
    description: "Return Prowlarr indexer status.",
    app: "prowlarr",
    path: "indexerstatus",
    schema: commonOptionsSchema
  },
  {
    name: "get_indexer_stats",
    title: "Get Prowlarr Indexer Stats",
    description: "Return Prowlarr indexer statistics.",
    app: "prowlarr",
    path: "indexerstats",
    schema: commonOptionsSchema
  },
  {
    name: "get_indexer_history",
    title: "Get Prowlarr Indexer History",
    description: "Return Prowlarr indexer history.",
    app: "prowlarr",
    path: "history",
    schema: commonOptionsSchema,
    query: historyQuery
  },
  {
    name: "test_indexer",
    title: "Test Prowlarr Indexer",
    description: "Trigger a Prowlarr indexer test.",
    app: "prowlarr",
    path: (args) => `indexer/test/${args.id}`,
    method: "POST",
    schema: commonOptionsSchema.extend({ id: z.union([z.string(), z.number()]) })
  },
  {
    name: "test_all_indexers",
    title: "Test All Prowlarr Indexers",
    description: "Trigger Prowlarr tests for all indexers.",
    app: "prowlarr",
    path: "indexer/testall",
    method: "POST",
    schema: commonOptionsSchema
  },
  {
    name: "get_applications",
    title: "Get Prowlarr Applications",
    description: "List Prowlarr application sync targets.",
    app: "prowlarr",
    path: "applications",
    schema: commonOptionsSchema
  }
];

function historyQuery(args: AnyArgs): Record<string, unknown> {
  return {
    page: args.page ?? 1,
    pageSize: args.pageSize ?? 100,
    ...(args.from ? { startDate: args.from } : {}),
    ...(args.to ? { endDate: args.to } : {}),
    sortKey: "date",
    sortDirection: "descending"
  };
}

function filterResponseItems(data: unknown, predicate: (item: unknown) => boolean): unknown {
  if (Array.isArray(data)) {
    return data.filter(predicate);
  }
  if (!data || typeof data !== "object") {
    return data;
  }

  const record = data as Record<string, unknown>;
  for (const key of ["records", "items", "results"]) {
    if (Array.isArray(record[key])) {
      const filtered = (record[key] as unknown[]).filter(predicate);
      return {
        ...record,
        [key]: filtered,
        totalRecords: filtered.length
      };
    }
  }
  return data;
}

function historyEventFilter(eventTypes: string[]): (item: unknown) => boolean {
  return (item) => historyEventMatches(item, eventTypes);
}

function historyEventMatches(item: unknown, eventTypes: string[]): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const eventType = (item as Record<string, unknown>).eventType;
  return typeof eventType === "string" && eventTypes.includes(eventType);
}

function queueQuery(args: AnyArgs): Record<string, unknown> {
  return {
    page: args.page ?? 1,
    pageSize: args.pageSize ?? 100,
    includeUnknownMovieItems: true,
    includeUnknownSeriesItems: true
  };
}

export function createCoreTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "health_check_all",
      title: "Health Check All",
      description: "Check status and health for every configured Servarr app.",
      inputSchema: commonOptionsSchema,
      async handler(_args, context) {
        const checks = await Promise.allSettled(
          configuredApps(context.config).map(async (app) => {
            const client = clientFor(context.config, app);
            const [status, health] = await Promise.all([client.status(), client.health()]);
            return { app, ok: true, status, health };
          })
        );
        return checks.map((result) =>
          result.status === "fulfilled"
            ? result.value
            : { ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
        );
      }
    },
    {
      name: "test_connection",
      title: "Test Connection",
      description: "Test connectivity for one Servarr app.",
      inputSchema: appOptionsSchema,
      async handler(args, context) {
        const client = clientFor(context.config, args.app);
        const status = await client.status();
        return { app: args.app, ok: true, status };
      }
    },
    {
      name: "continue_query",
      title: "Continue Query",
      description: "Continue a paged query from a cursor produced by a previous tool response.",
      inputSchema: z.object({ cursor: z.string().min(1) }),
      async handler(args, context) {
        const decoded = JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf8")) as CursorPayload;
        const data = await clientFor(context.config, decoded.app).request(decoded.path, decoded.query ? { query: decoded.query } : {});
        const nextOptions = {
          ...decoded.options,
          page: ((decoded.options.page as number | undefined) ?? 1) + 1
        };
        const nextCursor = encodeCursor(decoded.app, decoded.path, nextOptions, nextPageQuery(decoded.query, nextOptions.page));
        return shapeResult(data, decoded.options, { app: decoded.app, endpoint: decoded.path, nextCursor });
      }
    }
  ];

  return [
    ...tools,
    ...appReadTools.map(directTool),
    ...radarrTools.map(directTool),
    ...sonarrTools.map(directTool),
    ...prowlarrTools.map(directTool)
  ];
}

export function encodeCursor(app: AppName, path: string, options: CommonQueryOptions, query?: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ app, path, options, query }), "utf8").toString("base64url");
}

function nextPageQuery(query: Record<string, unknown> | undefined, page: number | undefined): Record<string, unknown> | undefined {
  if (!query) {
    return undefined;
  }
  return { ...query, page };
}
