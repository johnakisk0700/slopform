import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../src/tokens.css", import.meta.url));
const css = await readFile(file, "utf8");
const requiredTokens = [
  "--jts-color-canvas",
  "--jts-color-surface",
  "--jts-color-text",
  "--jts-color-primary",
  "--jts-color-focus",
  "--jts-font-sans",
  "--jts-space-4",
  "--jts-radius-md",
];

const missing = requiredTokens.filter((token) => !css.includes(`${token}:`));

if (missing.length > 0) {
  throw new Error(`Missing required design tokens: ${missing.join(", ")}`);
}
