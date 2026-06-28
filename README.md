# Servarr Analytics MCP

Servarr Analytics MCP is a Model Context Protocol server for Sonarr, Radarr, and Prowlarr. It gives AI clients a structured data interface for health checks, configuration reads, library analytics, simulations, backups, diffs, reports, and guarded write/bulk operations.

The MCP retrieves and aggregates data. The AI client analyzes the returned structured data and explains recommendations.

## Quick Start With npx

```bash
SONARR_URL=http://localhost:8989 \
SONARR_API_KEY=your-sonarr-api-key \
RADARR_URL=http://localhost:7878 \
RADARR_API_KEY=your-radarr-api-key \
PROWLARR_URL=http://localhost:9696 \
PROWLARR_API_KEY=your-prowlarr-api-key \
npx -y servarr-analytics-mcp
```

All diagnostics are written to stderr. stdout is reserved for MCP stdio protocol traffic.

## Docker

```bash
docker run --rm -i \
  -e SONARR_URL=http://host.docker.internal:8989 \
  -e SONARR_API_KEY=your-sonarr-api-key \
  -e RADARR_URL=http://host.docker.internal:7878 \
  -e RADARR_API_KEY=your-radarr-api-key \
  -e PROWLARR_URL=http://host.docker.internal:9696 \
  -e PROWLARR_API_KEY=your-prowlarr-api-key \
  ghcr.io/OWNER/servarr-analytics-mcp:latest
```

Replace `OWNER` with the GitHub owner that publishes the image.

## Docker Compose

```yaml
services:
  servarr-analytics-mcp:
    image: ghcr.io/OWNER/servarr-analytics-mcp:latest
    stdin_open: true
    environment:
      SONARR_URL: http://sonarr:8989
      SONARR_API_KEY: your-sonarr-api-key
      RADARR_URL: http://radarr:7878
      RADARR_API_KEY: your-radarr-api-key
      PROWLARR_URL: http://prowlarr:9696
      PROWLARR_API_KEY: your-prowlarr-api-key
    volumes:
      - servarr-analytics-backups:/app/.servarr-analytics-backups

volumes:
  servarr-analytics-backups:
```

## MCP JSON Config

```json
{
  "mcpServers": {
    "servarr-analytics": {
      "command": "npx",
      "args": ["-y", "servarr-analytics-mcp"],
      "env": {
        "SONARR_URL": "http://localhost:8989",
        "SONARR_API_KEY": "your-sonarr-api-key",
        "RADARR_URL": "http://localhost:7878",
        "RADARR_API_KEY": "your-radarr-api-key",
        "PROWLARR_URL": "http://localhost:9696",
        "PROWLARR_API_KEY": "your-prowlarr-api-key"
      }
    }
  }
}
```

## Codex TOML Config

```toml
[mcp_servers.servarr-analytics]
command = "npx"
args = ["-y", "servarr-analytics-mcp"]

[mcp_servers.servarr-analytics.env]
SONARR_URL = "http://localhost:8989"
SONARR_API_KEY = "your-sonarr-api-key"
RADARR_URL = "http://localhost:7878"
RADARR_API_KEY = "your-radarr-api-key"
PROWLARR_URL = "http://localhost:9696"
PROWLARR_API_KEY = "your-prowlarr-api-key"
```

## Configuration

Configure only the apps you want to expose. Each configured app requires both URL and API key.

| Variable | Required | Description |
| --- | --- | --- |
| `SONARR_URL` | optional | Sonarr base URL. |
| `SONARR_API_KEY` | optional | Sonarr API key. |
| `RADARR_URL` | optional | Radarr base URL. |
| `RADARR_API_KEY` | optional | Radarr API key. |
| `PROWLARR_URL` | optional | Prowlarr base URL. |
| `PROWLARR_API_KEY` | optional | Prowlarr API key. |
| `SONARR_API_BASE_PATH` | optional | API base path. Defaults to `/api/v3`. |
| `RADARR_API_BASE_PATH` | optional | API base path. Defaults to `/api/v3`. |
| `PROWLARR_API_BASE_PATH` | optional | API base path. Defaults to `/api/v1`. |
| `SERVARR_TIMEOUT_MS` | optional | HTTP timeout. Defaults to `30000`. |
| `SERVARR_BACKUP_DIR` | optional | Backup directory. Defaults to `.servarr-analytics-backups`. |

Do not commit API keys or real local URLs to a public repository.

## Tool Coverage

The server registers all tools from the initial architecture plan:

- Health: `health_check_all`, `get_system_status`, `get_app_config`, `test_connection`, `get_api_version`
- Configuration: quality profiles, definitions, custom formats, language/delay profiles, tags, root folders, download clients, indexers, notifications, metadata profiles, naming, media management, disk, health
- Library: Radarr movies/files/missing/cutoff unmet; Sonarr series/episodes/files/missing/cutoff unmet
- History and queue: history, grab/import/failed/deleted history, queue, queue details, blocklist
- Prowlarr: indexers, indexer status/stats/history/tests, download clients, applications
- Analytics: library, quality, codec, resolution, HDR, audio, profile, custom format, storage, tracker/indexer analytics
- Simulation: quality profile, custom format, cutoff, score, storage, upgrade, and codec strategy simulations
- Backup and diff: create/list/restore backup, generate diff, validate patch, dry-run patch, apply patch
- Write and bulk operations: quality profiles, custom formats, scores, quality definitions, delay profile, naming, media management, restrictions
- Reports: quality, storage, tracker, failed downloads, monthly statistics, recommendations

Some analytics and simulations are best-effort aggregations over the Servarr API data available to the configured app.

## Large Result Controls

Most read and analytics tools accept:

- `detail`: `summary`, `normal`, `verbose`, or `raw`
- `page`, `pageSize`, `limit`
- `from`, `to`
- `sampleRecords`
- `fields`
- `groupBy`
- `cursor`

Defaults protect the client context window:

- default `pageSize`: `100`
- max `pageSize`: `500`
- raw responses are capped
- aggregation is performed inside the MCP where possible

## Write Safety

Mutating tools require `confirm: true`. Restore and patch application also require `dryRun: false`.

Restore and patch operations are constrained by a safe endpoint allowlist. Collection updates such as quality profiles, custom formats, download clients, indexers, notifications, tags, and root folders must target a specific item id, for example `qualityprofile/3`. Singleton config endpoints such as `config/naming` and `config/mediamanagement` may be updated directly. A real backup restore also requires a specific `app` target.

Examples:

```json
{
  "app": "radarr",
  "id": 3,
  "body": {
    "name": "HD-1080p"
  },
  "confirm": true
}
```

Patch application:

```json
{
  "dryRun": false,
  "confirm": true,
  "operations": [
    {
      "app": "sonarr",
      "method": "PUT",
      "path": "qualityprofile/3",
      "body": {
        "id": 3,
        "name": "HD-1080p"
      }
    }
  ]
}
```

Always create a backup before write, restore, or bulk operations.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

Build output is written to `dist/`. The executable is `dist/index.js`.

## Release

Publishing is handled by GitHub Actions when a GitHub Release is published.

- npm publishes `servarr-analytics-mcp` through npm trusted publishing/OIDC.
- GHCR publishes `ghcr.io/<owner>/servarr-analytics-mcp`.
- The release tag must match `package.json`, for example `v0.1.0`.
- The workflow runs lint, tests, and build before publishing.

Before the first release:

1. Create the public GitHub repository.
2. Replace `OWNER` placeholders in docs/examples if desired.
3. Verify the npm package name is available.
4. Configure npm trusted publishing for `.github/workflows/release.yml`.
5. Publish a GitHub Release tagged `v0.1.0`.
