import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || path.resolve("target_data");
fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "POST") {
    const name = (new URL(req.url, "http://x").searchParams.get("name") || "capture").replace(/[^a-z0-9_-]/gi, "_");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const file = path.join(OUT, name + ".json");
      fs.writeFileSync(file, buf);
      console.log("saved", file, buf.length, "bytes");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: buf.length, file }));
    });
    return;
  }
  res.writeHead(200);
  res.end("ok");
});

server.listen(8899, "127.0.0.1", () => console.log("collect server on 8899 ->", OUT));
