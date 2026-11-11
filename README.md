# Wuhoo

A documentation management platform. Users connect Claude through MCP, ask Claude to create documentation from screenshots or screen recordings, and Wuhoo stores, edits and publishes that documentation.

## Project Structure

```
wuhoo/
├── apps/
│   ├── web/          # Next.js frontend (React, TypeScript, Tailwind CSS)
│   └── mcp/          # Remote MCP server (Node.js, TypeScript)
├── packages/
│   ├── core/         # Shared business logic
│   ├── database/     # Database client and schema
│   ├── validation/   # Shared validation schemas
│   └── config/       # Shared configuration
├── package.json
└── pnpm-workspace.yaml
```

## Prerequisites

- Node.js >= 18
- pnpm >= 9

## Getting Started

Install all dependencies from the root:

```bash
pnpm install
```

## Running the Applications

### Web app only (http://localhost:3000)

```bash
pnpm dev:web
```

### MCP server only (http://localhost:3001)

```bash
pnpm dev:mcp
```

### Both apps in parallel

```bash
pnpm dev
```

## Health Check

Once the MCP server is running, verify it with:

```bash
curl http://localhost:3001/health
# → {"status":"ok","service":"wuhoo-mcp"}
```
