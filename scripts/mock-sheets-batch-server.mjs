import { appendFile, chmod, readFile } from "node:fs/promises";
import http from "node:http";

const options = { port: 5800, eventLog: "", schemaPath: "" };
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  const key = separator >= 0 ? argument.slice(0, separator) : argument;
  const value = separator >= 0 ? argument.slice(separator + 1) : "";
  if (key === "--port") options.port = Number(value);
  else if (key === "--event-log") options.eventLog = value;
  else if (key === "--schema") options.schemaPath = value;
}
if (
  !Number.isInteger(options.port) ||
  options.port < 1024 ||
  options.port > 65535 ||
  !options.eventLog ||
  !options.schemaPath
) {
  throw new Error(
    "Usage: node scripts/mock-sheets-batch-server.mjs --port=<1024-65535> --event-log=<path> --schema=<pipeline-schema.json>"
  );
}

const schema = JSON.parse(await readFile(options.schemaPath, "utf8"));
if (schema?.business_stores?.length !== 5 || !Array.isArray(schema?.fields)) {
  throw new Error("mock Sheets server requires the five-store pipeline schema");
}
let requestIndex = 0;

async function record(status) {
  await appendFile(
    options.eventLog,
    `${JSON.stringify({
      request_index: requestIndex,
      observed_at: new Date().toISOString(),
      method: "GET",
      operation: "values.batchGet",
      status
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await chmod(options.eventLog, 0o600);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain", connection: "close" });
    response.end("ok");
    return;
  }
  if (request.method !== "GET" || !request.url?.startsWith("/values:batchGet")) {
    response.writeHead(404, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ error: { code: 404, message: "not found" } }));
    return;
  }
  requestIndex += 1;
  if (requestIndex === 1) {
    await record(429);
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "1",
      connection: "close"
    });
    response.end(JSON.stringify({ error: { code: 429, message: "quota window" } }));
    return;
  }
  await record(200);
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(
    JSON.stringify({
      spreadsheetId: "disposable-quota-probe",
      valueRanges: schema.business_stores.map((sheet) => ({
        range: `'${sheet}'!A1:BQ1`,
        majorDimension: "ROWS",
        values: [schema.fields]
      }))
    })
  );
});

server.listen(options.port, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ listening: true, host: "127.0.0.1", port: options.port })}\n`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
