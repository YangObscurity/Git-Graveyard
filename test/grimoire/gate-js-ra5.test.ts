import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCandidate,
  gateJs,
  tryParseJsOrTs,
} from "../../lib/grimoire/gate-js";

// Work package RA5 (Audit item N-A14):
// Prevent gate-js from parsing .jsx files with TypeScript Babel plugin.
// .jsx files must strictly parse as JavaScript with JSX and decorator plugins only,
// must never fall back to typescript plugin, and must not receive loose allow* options.
describe("grimoire/gate-js RA5: strict parsing for .jsx files without TypeScript plugin", () => {
  describe("valid .jsx React components pass gate-js", () => {
    it("passes gateJs for CommonJS React functional component in .jsx", () => {
      const code = [
        "const React = require('react');",
        "function Button({ label, onClick }) {",
        "  return <button className=\"btn\" onClick={onClick}>{label}</button>;",
        "}",
        "module.exports = { Button };",
      ].join("\n");

      const result = gateJs("src/components/Button.jsx", code);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
    });

    it("passes gateJs for CommonJS class component with JSX in .jsx", () => {
      const code = [
        "const React = require('react');",
        "class Counter extends React.Component {",
        "  render() {",
        "    return <div>Count: {this.props.initial}</div>;",
        "  }",
        "}",
        "module.exports = { Counter };",
      ].join("\n");

      const result = gateJs("src/Counter.jsx", code);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
    });

    it("passes gateJs for ESM React component in .jsx with type module package", () => {
      const code = [
        "import React from 'react';",
        "export const Card = ({ title, count, children }) => (",
        "  <>",
        "    <div className=\"card-header\">",
        "      <h2>{title}</h2>",
        "      <span>{count}</span>",
        "    </div>",
        "    <div className=\"card-body\">{children}</div>",
        "  </>",
        ");",
      ].join("\n");

      const result = gateJs("src/views/Card.jsx", code, [], {
        packageJson: { type: "module" },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
    });

    it("passes tryParseJsOrTs for valid JSX in both module and script modes", () => {
      const esmCode = "export const Hello = () => <div>Hello World</div>;\n";
      const modRes = tryParseJsOrTs(esmCode, "src/Hello.jsx", "module");
      assert.equal(modRes.ok, true);

      const cjsCode = "const React = require('react');\nmodule.exports = () => <span>Hi</span>;\n";
      const scriptRes = tryParseJsOrTs(cjsCode, "src/Hello.jsx", "script");
      assert.equal(scriptRes.ok, true);
    });

    it("passes checkCandidate for valid .jsx candidate files", () => {
      const candidate = {
        packageJson: { type: "module" },
        files: [
          {
            path: "src/App.jsx",
            content: "export const App = () => <main><h1>App</h1></main>;\n",
          },
          {
            path: "src/Item.jsx",
            content: "export const Item = ({ id }) => <li key={id}>{id}</li>;\n",
          },
        ],
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.equal(result.details?.["src/App.jsx"]?.ok, true);
      assert.equal(result.details?.["src/Item.jsx"]?.ok, true);
    });
  });

  describe("TypeScript annotations fail gate-js for .jsx files", () => {
    it("fails gateJs when a .jsx file contains const type annotations", () => {
      const code = "const x: number = 1;\nmodule.exports = { x };\n";
      const result = gateJs("src/Annotated.jsx", code);
      assert.equal(result.ok, false);
      assert(result.reasons.length >= 1);
      assert(result.reasons.some((r) => r.includes("original_unparseable")));
    });

    it("fails gateJs when a .jsx file contains interface declarations", () => {
      const code = [
        "interface Props {",
        "  label: string;",
        "}",
        "function Label(props) { return <span>{props.label}</span>; }",
        "module.exports = { Label };",
      ].join("\n");

      const result = gateJs("src/Label.jsx", code);
      assert.equal(result.ok, false);
      assert(result.reasons.length >= 1);
      assert(result.reasons.some((r) => r.includes("original_unparseable")));
    });

    it("fails tryParseJsOrTs when a .jsx file contains type alias declarations", () => {
      const code = "type ComponentProps = { id: string };\nexport const Comp = () => <div />;\n";
      const res = tryParseJsOrTs(code, "src/TypeAlias.jsx", "module");
      assert.equal(res.ok, false);
    });

    it("fails tryParseJsOrTs when a .jsx file contains parameter type annotations", () => {
      const code = "export function Widget(name: string) { return <div>{name}</div>; }\n";
      const res = tryParseJsOrTs(code, "src/Widget.jsx", "module");
      assert.equal(res.ok, false);
    });

    it("fails tryParseJsOrTs when a .jsx file contains TypeScript enum", () => {
      const code = "enum Status { Active, Inactive }\nconst s = Status.Active;\n";
      const res = tryParseJsOrTs(code, "src/Badge.jsx", "script");
      assert.equal(res.ok, false);
    });

    it("fails checkCandidate when a candidate file with .jsx has TypeScript annotations", () => {
      const candidate = {
        packageJson: { type: "module" },
        files: [
          {
            path: "src/TsxAsJsx.jsx",
            content: "interface User { name: string; }\nexport const UserView = (u: User) => <div>{u.name}</div>;\n",
          },
        ],
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, false);
      assert.equal(result.details?.["src/TsxAsJsx.jsx"]?.ok, false);
    });
  });

  describe("strict options enforcement on .jsx files", () => {
    it("fails tryParseJsOrTs for bare super call outside method in a .jsx file", () => {
      const code = "super.doSomething();\nexport const View = () => <div />;\n";
      const res = tryParseJsOrTs(code, "src/MisplacedSuper.jsx", "module");
      assert.equal(res.ok, false);
    });

    it("fails gateJs for misplaced super outside method in a .jsx file", () => {
      const code = "super.init();\nfunction Component() { return <div>Hello</div>; }\nmodule.exports = { Component };\n";
      const result = gateJs("src/MisplacedSuper.jsx", code);
      assert.equal(result.ok, false);
    });
  });

  describe("TypeScript syntax remains permitted in .ts and .tsx files", () => {
    it("successfully parses TypeScript interface and type annotations in .tsx files", () => {
      const tsxCode = [
        "interface Props {",
        "  label: string;",
        "}",
        "const count: number = 42;",
        "export const Comp = (props: Props) => <div>{props.label}: {count}</div>;",
      ].join("\n");

      const res = tryParseJsOrTs(tsxCode, "src/Component.tsx", "module");
      assert.equal(res.ok, true);

      const gateRes = gateJs("src/Component.tsx", tsxCode, [], {
        packageJson: { type: "module" },
      });
      assert.equal(gateRes.ok, true);
      assert.deepEqual(gateRes.reasons, []);
    });

    it("successfully parses TypeScript interface in .ts files", () => {
      const tsCode = "interface User { id: number; }\nconst u: User = { id: 1 };\n";
      const res = tryParseJsOrTs(tsCode, "src/user.ts", "module");
      assert.equal(res.ok, true);
    });
  });

  describe("grimoire/gate-js H-7: reject candidate.tree Record or Map", () => {
    it("rejects when candidate.tree is a Map", () => {
      const candidate = {
        tree: new Map([["src/index.js", "console.log('hello');"]]),
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, false);
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, [
        "invalid candidate.tree: expected string tree SHA, Record or Map is not supported; pass files as array of {path, content}",
      ]);
    });

    it("rejects when candidate.tree is a Record (plain object)", () => {
      const candidate = {
        tree: {
          "src/index.js": "console.log('hello');",
        },
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, false);
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.reasons, [
        "invalid candidate.tree: expected string tree SHA, Record or Map is not supported; pass files as array of {path, content}",
      ]);
    });

    it("emits gate.result event when candidate.tree is rejected and emit callback configured", () => {
      const emitted: any[] = [];
      const candidate = {
        tree: new Map([["src/index.js", "console.log('hello');"]]),
      };
      const result = checkCandidate(candidate, {
        emit: (res: any) => emitted.push(res),
      });
      assert.equal(result.ok, false);
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].ok, false);
      assert.deepEqual(emitted[0].reasons, [
        "invalid candidate.tree: expected string tree SHA, Record or Map is not supported; pass files as array of {path, content}",
      ]);
    });

    it("accepts candidate when candidate.tree is a string SHA and files are provided as array of {path, content}", () => {
      const candidate = {
        tree: "tree-sha-abcdef123456",
        files: [
          {
            path: "src/index.js",
            content: "console.log('hello');\n",
          },
        ],
      };
      const result = checkCandidate(candidate);
      assert.equal(result.ok, true);
      assert.deepEqual(result.reasons, []);
      assert.equal(result.tree, "tree-sha-abcdef123456");
    });
  });
});
