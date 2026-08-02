import { createHash } from "node:crypto";
import { appendFile, chmod, readFile } from "node:fs/promises";
import http from "node:http";

const options = { port: 5799, modeFile: "", eventLog: "" };
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  const key = separator >= 0 ? argument.slice(0, separator) : argument;
  const value = separator >= 0 ? argument.slice(separator + 1) : "";
  if (key === "--port") options.port = Number(value);
  else if (key === "--mode-file") options.modeFile = value;
  else if (key === "--event-log") options.eventLog = value;
}

if (
  !Number.isInteger(options.port) ||
  options.port < 1024 ||
  options.port > 65535 ||
  !options.modeFile ||
  !options.eventLog
) {
  throw new Error(
    "Usage: node scripts/mock-slack-server.mjs --port=<1024-65535> --mode-file=<path> --event-log=<path>"
  );
}

let requestIndex = 0;
async function responseMode() {
  const value = (await readFile(options.modeFile, "utf8")).trim();
  if (!new Set(["success", "retryable_failure", "ambiguous_drop"]).has(value)) {
    throw new Error("mock Slack response mode is invalid");
  }
  return value;
}

async function recordEvent(event) {
  await appendFile(options.eventLog, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(options.eventLog, 0o600);
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/slack") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }

  const chunks = [];
  let totalBytes = 0;
  request.on("data", (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes <= 1_000_000) chunks.push(chunk);
  });
  request.on("end", async () => {
    try {
      if (totalBytes > 1_000_000) {
        response.writeHead(413, { "content-type": "text/plain" });
        response.end("payload too large");
        return;
      }
      const body = Buffer.concat(chunks);
      const mode = await responseMode();
      requestIndex += 1;
      const status = mode === "success" ? 200 : mode === "retryable_failure" ? 503 : 0;
      await recordEvent({
        request_index: requestIndex,
        observed_at: new Date().toISOString(),
        method: request.method,
        path: request.url,
        content_length: body.length,
        body_sha256: createHash("sha256").update(body).digest("hex"),
        mode,
        status
      });
      if (mode === "ambiguous_drop") {
        request.socket.destroy();
        return;
      }
      response.writeHead(status, {
        "content-type": "text/plain",
        connection: "close"
      });
      response.end(mode === "success" ? "ok" : "temporary failure");
    } catch {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("mock failure");
    }
  });
});

server.listen(options.port, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ listening: true, host: "127.0.0.1", port: options.port })}\n`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
