import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

loadLocalEnv();

const { handler } = await import("./lambda.mjs");
const port = Number(process.env.PORT || 8787);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  const result = await handler({
    rawPath: new URL(req.url, `http://${req.headers.host}`).pathname,
    requestContext: { http: { method: req.method } },
    headers: req.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  });

  res.writeHead(result.statusCode, result.headers);
  res.end(result.body);
});

server.listen(port, () => {
  console.log(`FotoStock API local escuchando en http://localhost:${port}`);
});

function loadLocalEnv() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, ".env.local"),
    path.join(currentDir, ".env"),
    path.join(currentDir, "..", ".env.local"),
    path.join(currentDir, "..", ".env"),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;

    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }

    return;
  }
}
