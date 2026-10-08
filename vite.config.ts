import vinext from "vinext";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const defaultZwiftDirectory = fileURLToPath(
  new URL("../Zwift Files/", import.meta.url),
);

function localZwiftProtocolFiles(): Plugin {
  return {
    name: "local-zwift-protocol-files",
    configureServer(server) {
      server.middlewares.use("/api/local-protocol", async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        const rawParticipant = requestUrl.searchParams.get("participant") ?? "";
        const participant = rawParticipant.trim().toUpperCase();

        response.setHeader("Cache-Control", "no-store");
        if (!/^P\d+(?:_\d+)?$/.test(participant)) {
          response.statusCode = 400;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(
            JSON.stringify({ error: "Enter a participant such as P6 or P12." }),
          );
          return;
        }

        const zwiftDirectory = process.env.ZWIFT_FILES_DIRECTORY
          ? path.resolve(process.env.ZWIFT_FILES_DIRECTORY)
          : defaultZwiftDirectory;
        const expectedName = `${participant} Day 4.csv`;

        try {
          const names = await readdir(zwiftDirectory);
          const matchedName = names.find(
            (name) => name.toLowerCase() === expectedName.toLowerCase(),
          );
          if (!matchedName) {
            response.statusCode = 404;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(
              JSON.stringify({
                error: `${expectedName} was not found in the Day 4/Zwift Files folder.`,
              }),
            );
            return;
          }

          const csv = await readFile(path.join(zwiftDirectory, matchedName), "utf8");
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/csv; charset=utf-8");
          response.setHeader(
            "Content-Disposition",
            `inline; filename="${matchedName}"`,
          );
          response.end(csv);
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? `The Zwift Files folder could not be read: ${error.message}`
                  : "The Zwift Files folder could not be read.",
            }),
          );
        }
      });
    },
  };
}

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      strictPort: true,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      localZwiftProtocolFiles(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
