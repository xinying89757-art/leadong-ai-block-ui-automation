import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "fixtures", "images", "ai-block-test-image.png");
await mkdir(path.dirname(outputPath), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html><head><style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 800px; height: 600px; }
      body { display: grid; place-items: center; color: #fff; font-family: Arial, sans-serif;
        background: linear-gradient(135deg, #155e75 0%, #2563eb 52%, #7c3aed 100%); }
      main { text-align: center; padding: 44px 60px; border: 2px solid rgba(255,255,255,.65);
        border-radius: 20px; background: rgba(15, 23, 42, .2); }
      h1 { margin: 0; font-size: 48px; line-height: 1.2; letter-spacing: .5px; }
      p { margin: 18px 0 0; font-size: 18px; opacity: .9; }
    </style></head><body><main><h1>AI Block Test Image</h1><p>Local image input fixture · 800 × 600</p></main></body></html>`);
  await page.screenshot({ path: outputPath, type: "png" });
} finally {
  await browser.close();
}
console.log(`Generated ${path.relative(projectRoot, outputPath)}`);
