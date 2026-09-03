import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suffix = randomUUID().slice(0, 8);
const imageName = `fabric-semantic-model-mcp:smoke-${suffix}`;
const containerName = `fabric-semantic-model-mcp-smoke-${suffix}`;
const apiKey = `container-smoke-${randomUUID()}-${randomUUID()}`;
const expectedNodeVersion = `v${readFileSync(resolve(projectRoot, ".node-version"), "utf8").trim()}`;
let containerCreated = false;
let imageCreated = false;

function docker(args: readonly string[], options: Readonly<{ quiet?: boolean }> = {}): string {
  return execFileSync("docker", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function inspect(format: string): string {
  return docker(["inspect", "--format", format, containerName], { quiet: true }).trim();
}

function publishedBaseUrl(): string {
  const publishedPort = docker(["port", containerName, "3000/tcp"], { quiet: true }).trim();
  const match = /:(\d+)$/u.exec(publishedPort);
  if (!match) throw new Error(`Could not parse the published port from: ${publishedPort}`);
  return `http://127.0.0.1:${match[1]}`;
}

async function waitForHealthy(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`Health endpoint returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Container did not become healthy within 60 seconds.", { cause: lastError });
}

async function verifyHttpAndMcp(baseUrl: string): Promise<void> {
  const health = await fetch(`${baseUrl}/health`);
  const healthBody: unknown = await health.json();
  if (
    health.status !== 200 ||
    !healthBody ||
    typeof healthBody !== "object" ||
    !("status" in healthBody) ||
    healthBody.status !== "ok"
  ) {
    throw new Error("The container health probe did not return the expected response.");
  }

  const ready = await fetch(`${baseUrl}/ready`);
  const readyBody: unknown = await ready.json();
  if (
    ready.status !== 200 ||
    !readyBody ||
    typeof readyBody !== "object" ||
    !("status" in readyBody) ||
    readyBody.status !== "ready"
  ) {
    throw new Error("The container readiness probe did not return the expected response.");
  }

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (unauthorized.status !== 401) {
    throw new Error(`Unauthenticated MCP request returned ${unauthorized.status}, not 401.`);
  }

  const client = new Client({ name: "release-container-smoke", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        authProvider: { token: () => Promise.resolve(apiKey) },
      }),
    );
    const tools = await client.listTools();
    if (tools.tools.length !== 18) {
      throw new Error(`Expected 18 MCP tools, received ${tools.tools.length}.`);
    }
    const resources = await client.listResources();
    if (resources.resources.length !== 2) {
      throw new Error(`Expected 2 MCP resources, received ${resources.resources.length}.`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

try {
  docker(["build", "--pull", "--tag", imageName, "."]);
  imageCreated = true;
  docker(
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--publish",
      "127.0.0.1::3000",
      "--env",
      `MCP_API_KEY=${apiKey}`,
      "--env",
      "AZURE_AUTH_MODE=default",
      "--env",
      "POWERBI_MCP_READONLY=true",
      "--env",
      "LOG_LEVEL=info",
      imageName,
    ],
    { quiet: true },
  );
  containerCreated = true;

  let baseUrl = publishedBaseUrl();

  if (inspect("{{.Config.User}}") !== "node") {
    throw new Error("The production container is not configured to run as the node user.");
  }
  const uid = docker(["exec", containerName, "id", "-u"], { quiet: true }).trim();
  if (uid === "0") throw new Error("The production process is running as root.");
  const actualNodeVersion = docker(["exec", containerName, "node", "--version"], {
    quiet: true,
  }).trim();
  if (actualNodeVersion !== expectedNodeVersion) {
    throw new Error(`Expected Node ${expectedNodeVersion}, received ${actualNodeVersion}.`);
  }
  const devDependency = docker(
    [
      "exec",
      containerName,
      "node",
      "-e",
      "import('tsx').then(() => process.stdout.write('present'), () => process.stdout.write('absent'))",
    ],
    { quiet: true },
  ).trim();
  if (devDependency !== "absent") {
    throw new Error("A development-only dependency was present in the production image.");
  }

  await waitForHealthy(baseUrl);
  await verifyHttpAndMcp(baseUrl);

  docker(["restart", "--timeout", "10", containerName], { quiet: true });
  baseUrl = publishedBaseUrl();
  await waitForHealthy(baseUrl);
  await verifyHttpAndMcp(baseUrl);

  const logs = docker(["logs", containerName], { quiet: true });
  if (logs.includes(apiKey)) throw new Error("The MCP API key appeared in container logs.");

  docker(["stop", "--timeout", "10", containerName], { quiet: true });
  if (inspect("{{.State.ExitCode}}") !== "0") {
    throw new Error("The container did not exit cleanly after SIGTERM.");
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, nodeVersion: actualNodeVersion, nonRootUid: uid, toolCount: 18, resourceCount: 2, restartVerified: true, gracefulShutdownVerified: true })}\n`,
  );
} finally {
  if (containerCreated) {
    try {
      docker(["rm", "--force", containerName], { quiet: true });
    } catch {
      // Preserve the primary verification failure.
    }
  }
  if (imageCreated && process.env["KEEP_CONTAINER_SMOKE_IMAGE"] !== "true") {
    try {
      docker(["image", "rm", "--force", imageName], { quiet: true });
    } catch {
      // Preserve the primary verification failure.
    }
  }
}
