import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";

import {
  lintUiCopy,
  checkKiroBrandingCopy,
} from "../../lib/copy/claims-linter";
import { GATE_FOOTER, KIRO_ROLE_SENTENCE } from "../../lib/copy/glossary";

const ROOT_DIR = process.cwd();
const SCAN_ROOTS = ["components", "app"] as const;
const SKIP_PREFIXES = [
  path.join("components", "debug"),
  path.join("app", "debug"),
];

const UI_COPY_ATTRS = new Set([
  "placeholder",
  "title",
  "aria-label",
  "aria-description",
  "alt",
  "label",
  "emptyNotice",
  "description",
]);

const NON_UI_ATTRS = new Set([
  "className",
  "id",
  "htmlFor",
  "href",
  "src",
  "type",
  "name",
  "role",
  "style",
  "key",
  "autoComplete",
  "accept",
  "pattern",
  "method",
  "encType",
  "viewBox",
  "d",
  "fill",
  "stroke",
  "strokeLinecap",
  "strokeLinejoin",
  "points",
]);

interface ExtractedCopy {
  file: string;
  line: number;
  kind: "jsx-text" | "jsx-attr" | "jsx-expr" | "string-literal";
  text: string;
}

function collectTsxFiles(dirRel: string): string[] {
  const absDir = path.join(ROOT_DIR, dirRel);
  if (!fs.existsSync(absDir)) return [];

  const results: string[] = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const relPath = path.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix + path.sep))) {
        continue;
      }
      results.push(...collectTsxFiles(relPath));
    } else if (entry.name.endsWith(".tsx")) {
      results.push(relPath);
    }
  }
  return results;
}

interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

function walkAst(
  node: AstNode | null | undefined,
  visitor: (node: AstNode, parents: AstNode[]) => void,
  parents: AstNode[] = []
): void {
  if (!node || typeof node !== "object" || typeof node.type !== "string") {
    return;
  }
  visitor(node, parents);
  const nextParents = [...parents, node];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof (item as AstNode).type === "string") {
          walkAst(item as AstNode, visitor, nextParents);
        }
      }
    } else if (val && typeof (val as AstNode).type === "string") {
      walkAst(val as AstNode, visitor, nextParents);
    }
  }
}

function extractUiCopyFromFile(relPath: string): ExtractedCopy[] {
  const source = fs.readFileSync(path.join(ROOT_DIR, relPath), "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  }) as unknown as AstNode;

  const extracted: ExtractedCopy[] = [];

  walkAst(ast, (node, parents) => {
    const parent = parents[parents.length - 1];
    const line = node.loc?.start.line ?? 0;

    if (node.type === "JSXText") {
      const normalized = String(node.value ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (normalized) {
        extracted.push({ file: relPath, line, kind: "jsx-text", text: normalized });
      }
      return;
    }

    if (node.type === "StringLiteral") {
      if (
        parent?.type === "ImportDeclaration" ||
        parent?.type === "ExportAllDeclaration" ||
        parent?.type === "TSLiteralType"
      ) {
        return;
      }

      const value = String(node.value ?? "");
      if (!value.trim()) return;

      const attrAncestor = [...parents]
        .reverse()
        .find((p) => p.type === "JSXAttribute") as
        | (AstNode & { name?: { name?: string } })
        | undefined;

      if (attrAncestor) {
        const attrName = String(attrAncestor.name?.name ?? "");
        if (attrName.startsWith("data-") || NON_UI_ATTRS.has(attrName)) {
          return;
        }
        if (UI_COPY_ATTRS.has(attrName)) {
          extracted.push({ file: relPath, line, kind: "jsx-attr", text: value });
          return;
        }
      }

      if (parents.some((p) => p.type === "JSXExpressionContainer")) {
        extracted.push({ file: relPath, line, kind: "jsx-expr", text: value });
        return;
      }

      extracted.push({ file: relPath, line, kind: "string-literal", text: value });
      return;
    }

    if (node.type === "TemplateElement") {
      const attrAncestor = [...parents]
        .reverse()
        .find((p) => p.type === "JSXAttribute") as
        | (AstNode & { name?: { name?: string } })
        | undefined;
      if (attrAncestor) {
        const attrName = String(attrAncestor.name?.name ?? "");
        if (attrName.startsWith("data-") || NON_UI_ATTRS.has(attrName)) {
          return;
        }
      }

      if (parents.some((p) => p.type === "JSXExpressionContainer")) {
        const valObj = node.value as { cooked?: string; raw?: string } | undefined;
        const cooked = (valObj?.cooked ?? valObj?.raw ?? "").trim();
        if (cooked) {
          extracted.push({ file: relPath, line, kind: "jsx-expr", text: cooked });
        }
      }
    }
  });

  return extracted;
}

describe("Repository-wide UI copy scan (components/**/*.tsx and app/**/*.tsx)", () => {
  const files = SCAN_ROOTS.flatMap(collectTsxFiles).sort();

  it("discovers non-debug TSX files across components/ and app/", () => {
    assert.ok(files.length > 0, "expected TSX files to scan");
    for (const f of files) {
      assert.ok(!f.startsWith(path.join("components", "debug") + path.sep));
      assert.ok(!f.startsWith(path.join("app", "debug") + path.sep));
    }
  });

  it("passes lintUiCopy and checkKiroBrandingCopy for all extracted UI copy", () => {
    const violations: string[] = [];

    for (const file of files) {
      const items = extractUiCopyFromFile(file);
      for (const item of items) {
        const lint = lintUiCopy(item.text);
        const branding = checkKiroBrandingCopy(
          item.text,
          item.text === KIRO_ROLE_SENTENCE
            ? "role"
            : item.text === GATE_FOOTER
            ? "gate"
            : undefined
        );

        if (!lint.ok || !branding.ok) {
          const allFindings = [...lint.findings, ...branding.findings]
            .map((f) => `${f.rule}: ${f.message}`)
            .join("; ");
          violations.push(
            `${item.file}:${item.line} [${item.kind}] ${JSON.stringify(item.text)} -> ${allFindings}`
          );
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `UI copy scan found violations:\n${violations.join("\n")}`
    );
  });
});
