// Tiny static server for the dashboard: `npm run dashboard` → http://localhost:4317
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const root = process.cwd(); const port = Number(process.env.PORT ?? 4317);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".jsonl": "text/plain", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? "/").split("?")[0]); if (p === "/") p = "/dashboard/index.html";
  const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`echo dashboard → http://localhost:${port}`));
