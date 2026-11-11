import http from "http";

const PORT = process.env.PORT ?? 3001;

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "wuhoo-mcp" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`MCP server running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
