import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Day 4 protocol timer", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Day 4 Protocol Timer<\/title>/i);
  assert.match(html, /Time left at current power/);
  assert.match(html, /Next interval/);
  assert.match(html, /Add 5:00 at 50 W/);
  assert.match(html, /Load participant protocol/);
  assert.match(html, /No protocol loaded/);
  assert.match(html, /Day 4\/Zwift Files/);
  assert.match(html, /Choose CSV/);
  assert.doesNotMatch(html, /P6 is loaded/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships the expected protocol and CSV safeguards", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  const launcher = await readFile(
    new URL("../Start Day 4 Timer.bat", import.meta.url),
    "utf8",
  );
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");

  assert.match(page, /const EXTRA_WARMUP_SECONDS = 5 \* 60/);
  assert.match(page, /useState<Segment\[\]>\(\[\]\)/);
  assert.doesNotMatch(page, /BUILT_IN_PROTOCOL|initialProtocol|p6-\$\{/);
  assert.match(page, /headers\.indexOf\("time_s"\)/);
  assert.match(page, /headers\.indexOf\("power_w"\)/);
  assert.match(page, /time_s must run continuously from 0/);
  assert.match(page, /active\.duration \+= EXTRA_WARMUP_SECONDS/);
  assert.match(page, /nextSegments\.splice\(index \+ 1, 0/);
  assert.match(page, /\/api\/local-protocol\?participant=/);
  assert.match(page, /function ProtocolLineChart/);
  assert.match(page, /Power over time/);
  assert.match(page, /Tabata effort \$\{effortNumber\} of \$\{totalEfforts\}/);
  assert.match(page, /tabata-effort-label/);
  assert.match(page, /horizontal axis is time and the vertical axis is power in watts/);
  assert.doesNotMatch(page, /timeline-block/);
  assert.match(viteConfig, /new URL\("\.\.\/Zwift Files\/", import\.meta\.url\)/);
  assert.match(viteConfig, /const expectedName = `\$\{participant\} Day 4\.csv`/);
  assert.match(viteConfig, /await readdir\(zwiftDirectory\)/);
  assert.match(viteConfig, /await readFile\(path\.join\(zwiftDirectory, matchedName\), "utf8"\)/);
  assert.match(launcher, /title Day 4 Protocol Timer/);
  assert.match(launcher, /http:\/\/localhost:3000\//);
  assert.match(launcher, /node_modules\\vinext\\dist\\cli\.js/);
  assert.match(launcher, /Start-Process \$url/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await access(projectRoot);
});
