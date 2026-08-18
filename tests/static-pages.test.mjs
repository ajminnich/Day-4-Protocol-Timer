import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const output = new URL("../pages-dist/", import.meta.url);

test("builds an installable GitHub Pages webpage", async () => {
  const html = await readFile(new URL("index.html", output), "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("manifest.webmanifest", output), "utf8"),
  );
  const serviceWorker = await readFile(new URL("sw.js", output), "utf8");

  assert.match(html, /<title>Day 4 Protocol Timer<\/title>/i);
  assert.match(html, /\.\/assets\/index-[^"']+\.js/);
  assert.equal(manifest.name, "Day 4 Protocol Timer");
  assert.equal(manifest.display, "standalone");
  assert.match(serviceWorker, /day4-protocol-timer-v1/);
  assert.match(serviceWorker, /\.\/index\.html/);
  await access(new URL("favicon.svg", output));
});

test("does not publish participant protocol files", async () => {
  const files = await readdir(output, { recursive: true });
  assert.equal(files.some((file) => /\.csv$/i.test(file)), false);
});
