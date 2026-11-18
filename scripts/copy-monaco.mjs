import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const srcDir = path.join(rootDir, "node_modules", "monaco-editor", "min", "vs");
const destDir = path.join(rootDir, "public", "monaco", "vs");

if (!fs.existsSync(srcDir)) {
  console.error(`Monaco assets not found at ${path.relative(rootDir, srcDir)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destDir), { recursive: true });
fs.cpSync(srcDir, destDir, { recursive: true, force: true });
console.log(
  `Copied Monaco assets from ${path.relative(rootDir, srcDir)} to ${path.relative(rootDir, destDir)}`
);
