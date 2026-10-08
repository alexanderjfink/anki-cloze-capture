import { rm, mkdir, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const SRC = join(ROOT, "src");
const PUBLIC = join(ROOT, "public");
const DIST = join(ROOT, "dist");
const watch = process.argv.includes("--watch");

const ENTRIES = [
  "background",
  "content",
  "options",
  "popup",
].map((name) => join(SRC, "entry", `${name}.ts`));

async function copyPublic() {
  if (!existsSync(PUBLIC)) return;
  const files = await readdir(PUBLIC);
  for (const file of files) {
    await cp(join(PUBLIC, file), join(DIST, file));
  }
}

async function buildOnce() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const result = await Bun.build({
    entrypoints: ENTRIES,
    outdir: DIST,
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "linked",
    naming: "[name].js",
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Build failed");
  }

  await copyPublic();

  console.log(`Built ${ENTRIES.length} entries -> ${DIST}`);
}

async function main() {
  await buildOnce();
  if (!watch) return;

  const { watch: fsWatch } = await import("node:fs");
  console.log("Watching src/ and public/ for changes...");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      buildOnce().catch((err) => console.error(err));
    }, 150);
  };
  fsWatch(SRC, { recursive: true }, schedule);
  fsWatch(PUBLIC, { recursive: true }, schedule);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
