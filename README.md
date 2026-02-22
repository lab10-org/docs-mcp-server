# Docs MCP Server

**Maintained by [Lab10](https://lab10.ai)** — helping companies drive AI adoption and increase their value.

Docs MCP Server solves the problem of AI hallucinations and outdated knowledge by providing an always-current documentation index for your AI coding assistant. It fetches official docs from websites, GitHub, npm, PyPI, and local files, allowing your AI to query the exact version you are using.

> This project is a fork of [arabold/docs-mcp-server](https://github.com/arabold/docs-mcp-server) by **Andre Rabold**, licensed under MIT. Lab10 extends it with additional features tailored to enterprise deployment needs.

![Docs MCP Server Web Interface](docs/docs-mcp-server.png)

## Why Docs MCP Server?

- **Up-to-Date Context:** Fetches documentation directly from official sources on demand.
- **Version-Specific:** Queries target the exact library versions in your project.
- **Reduces Hallucinations:** Grounds LLMs in real documentation.
- **Multiple Sources:** Index websites, GitHub repositories, local folders, and zip archives.
- **Rich File Support:** Processes HTML, Markdown, PDF, Word (.docx), Excel, PowerPoint, and source code.
- **Broad Compatibility:** Works with any MCP-compatible client (Claude, Cline, Cursor, etc.).
- **Production-Ready:** Distributed deployment with auth, Railway config-as-code, and Docker Compose.

---

## Deployment

### Docker Compose

The recommended way to run a production instance with two services: a private **worker** (processes documentation) and a public **MCP + API** server (serves clients with JWT auth).

```bash
cp .env.production.example .env
# Edit .env with your real values (storage, auth, embeddings)
docker compose -f docker-compose.production.yml up -d
```

See `.env.production.example` for the full list of environment variables.

### Railway

Config-as-code files are provided in the `railway/` directory:

| Service | Config | Networking |
|---|---|---|
| Worker | `railway/worker.toml` | Private (internal only) |
| MCP + API | `railway/mcp.toml` | Public (enable domain) |

**Setup:**

1. Create a new Railway project linked to this repo.
2. Add two services, each pointing to its respective TOML config file.
3. Set environment variables per service (see `.env.production.example` for the Railway section).
4. The MCP service connects to the worker via Railway reference variables:
   ```
   WORKER_URL=http://${{worker.RAILWAY_PRIVATE_DOMAIN}}:${{worker.PORT}}/api
   ```
5. **Volumes** (dashboard only — not supported in TOML config): attach a volume to the **worker** service with mount path `/data` for persistent storage. Optionally mount `/config` for configuration persistence.

### Docker (standalone)

For local development or single-machine deployments:

```bash
docker run --rm \
  -v docs-mcp-data:/data \
  -v docs-mcp-config:/config \
  -p 6280:6280 \
  ghcr.io/arabold/docs-mcp-server:latest \
  --protocol http --host 0.0.0.0 --port 6280
```

---

## Connecting Clients

Add this to your MCP client settings (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "docs-mcp-server": {
      "type": "sse",
      "url": "http://localhost:6280/sse"
    }
  }
}
```

See **[Connecting Clients](docs/guides/mcp-clients.md)** for VS Code (Cline, Roo) and other setup options.

---

## Configuration

### Embedding Model (Recommended)

Using an embedding model is **optional** but dramatically improves search quality by enabling semantic vector search.

```bash
OPENAI_API_KEY="sk-proj-..." docker compose -f docker-compose.production.yml up -d
```

See **[Embedding Models](docs/guides/embedding-models.md)** for configuring **Ollama**, **Gemini**, **Azure**, and others.

### Storage Provider

By default, data is stored locally using **SQLite**. For team or cloud deployments, use **Supabase (PostgreSQL)**:

```bash
DOCS_MCP_STORAGE_PROVIDER=supabase
DATABASE_URL="postgresql://user:pass@host:5432/db"
SUPABASE_SCHEMA=docs_prod  # optional, isolate tables into a custom schema
```

See **[Configuration](docs/setup/configuration.md)** for the full reference.

### Authentication

Production deployments use OAuth2/OIDC JWT authentication to protect all public endpoints:

```bash
DOCS_MCP_AUTH_ENABLED=true
DOCS_MCP_AUTH_ISSUER_URL=https://your-auth-provider/.well-known/openid-configuration
DOCS_MCP_AUTH_AUDIENCE=urn:docs-mcp-server
```

See **[Authentication](docs/infrastructure/authentication.md)** for details.

---

## Documentation

- **[Installation](docs/setup/installation.md)**: Setup guides for Docker and embedded mode.
- **[Connecting Clients](docs/guides/mcp-clients.md)**: Claude, VS Code (Cline/Roo), and other MCP clients.
- **[Basic Usage](docs/guides/basic-usage.md)**: Using the Web UI, CLI, and scraping local files.
- **[Configuration](docs/setup/configuration.md)**: Full reference for config files and environment variables.
- **[Embedding Models](docs/guides/embedding-models.md)**: Configure OpenAI, Ollama, Gemini, and other providers.
- **[Deployment Modes](docs/infrastructure/deployment-modes.md)**: Standalone vs. Distributed (Docker Compose).
- **[Authentication](docs/infrastructure/authentication.md)**: Securing your server with OAuth2/OIDC.
- **[Architecture](ARCHITECTURE.md)**: Deep dive into the system design.

---

## Contributing

We welcome contributions! Please see **[CONTRIBUTING.md](CONTRIBUTING.md)** for development guidelines and setup instructions.

## Acknowledgements

This project is based on [docs-mcp-server](https://github.com/arabold/docs-mcp-server) originally created by [Andre Rabold](https://github.com/arabold). We are grateful for his work in building the foundation of this tool.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
