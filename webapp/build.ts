import tailwind from "bun-plugin-tailwind";
import { rm, copyFile } from "node:fs/promises";
import path from "node:path";

const outdir = path.join(process.cwd(), "dist");
await rm(outdir, { recursive: true, force: true });

const entrypoints = [...new Bun.Glob("src/**/*.html").scanSync()];

const result = await Bun.build({
  entrypoints,
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

for (const output of result.outputs) {
  console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
}

// Copy PWA assets to dist
const pwaFiles = ["manifest.json", "sw.js", "icon.svg", "icon-192.png", "icon-512.png"];
for (const file of pwaFiles) {
  try {
    await copyFile(path.join("src", file), path.join(outdir, file));
    console.log(` Copied PWA asset: dist/${file}`);
  } catch (err: any) {
    console.warn(`Could not copy ${file}:`, err.message);
  }
}

