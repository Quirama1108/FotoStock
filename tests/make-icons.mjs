// One-off: render icons/icon.svg to the PNG sizes Android/iOS need. Run: node tests/make-icons.mjs
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const svg = await readFile(new URL("../icons/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch({ channel: "chrome" });
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: fileURLToPath(new URL(`../icons/icon-${size}.png`, import.meta.url)) });
  await page.close();
}
await browser.close();
