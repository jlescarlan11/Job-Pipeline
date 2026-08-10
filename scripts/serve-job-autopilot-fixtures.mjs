#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const fixtureRoot = new URL("../tests/fixtures/onlinejobs/", import.meta.url);
const replay = JSON.parse(await readFile(new URL("replay.json", fixtureRoot)));
const allowed = new Set(replay.cases.map((entry) => entry.fixture));
const requestedPort = Number(process.env.JOB_AUTOPILOT_FIXTURE_PORT || 4177);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
  throw new Error("JOB_AUTOPILOT_FIXTURE_PORT must be an unprivileged TCP port");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const fixture = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (request.method !== "GET" || !allowed.has(fixture)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("fixture not found\n");
    return;
  }
  const body = await readFile(new URL(fixture, fixtureRoot));
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "x-job-autopilot-fixture": fixture
  });
  response.end(body);
});

server.listen(requestedPort, "127.0.0.1", () => {
  process.stdout.write(`Job Autopilot fixtures: http://127.0.0.1:${requestedPort}/standard.html\n`);
});
