import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";

async function main() {
  try {
    await Parser.init();

    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("tree-sitter-python/tree-sitter-python.wasm");

    const pythonLanguage = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(pythonLanguage);

    const testSnippet = "def main():\n    return 42\n";
    const tree = parser.parse(testSnippet);
    if (!tree || tree.rootNode.type !== "module") {
      throw new Error("Parser failed to produce a valid module root node");
    }

    console.log("web-tree-sitter and tree-sitter-python wasm verified successfully.");
  } catch (error) {
    console.error("WASM check failed:", error);
    process.exit(1);
  }
}

await main();
