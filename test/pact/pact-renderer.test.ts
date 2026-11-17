import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { parsePact, type PactTask } from "../../lib/pact/pact-parser";
import {
  renderPact,
  renderTask,
  renderTasks,
  renderTasksMd,
  type PactInput,
} from "../../lib/pact/pact-renderer";

describe("Pact Renderer: Formatting (Requirement 12.12)", () => {
  it("formats single task with required metadata bullets", () => {
    const task: PactTask = {
      id: "T1",
      title: "Update dependencies",
      role: "bonesetter",
      dependencies: [],
      depends: [],
      dependsOn: [],
      files: ["package.json"],
      filesInScope: ["package.json"],
      acceptanceCommand: "npm test",
      accept: "npm test",
      hard: false,
      hardFlag: false,
      hardRaw: "no",
      rules: ["M1"],
      ruleIds: ["M1"],
      line: 1,
    };

    const rendered = renderTask(task);
    assert.match(rendered, /^- \[ \] T1\. Update dependencies$/m);
    assert.match(rendered, /^  - role: bonesetter$/m);
    assert.match(rendered, /^  - depends:$/m);
    assert.match(rendered, /^  - files: package\.json$/m);
    assert.match(rendered, /^  - accept: npm test$/m);
    assert.match(rendered, /^  - hard: no$/m);
    assert.match(rendered, /^  - rules: M1$/m);
  });

  it("formats soul-stitcher task with hard: yes and multiple dependencies, files, and rules", () => {
    const task: Partial<PactTask> = {
      id: "T2",
      title: "Migrate request calls to fetch adapter",
      role: "soul-stitcher",
      depends: ["T1", "T0"],
      files: ["lib/request.js", "lib/http.js"],
      accept: "npm test -- test/request.test.js",
      hard: true,
      rules: ["M2", "M3"],
    };

    const rendered = renderTask(task);
    assert.match(rendered, /^- \[ \] T2\. Migrate request calls to fetch adapter$/m);
    assert.match(rendered, /^  - role: soul-stitcher$/m);
    assert.match(rendered, /^  - depends: T1, T0$/m);
    assert.match(rendered, /^  - files: lib\/request\.js, lib\/http\.js$/m);
    assert.match(rendered, /^  - accept: npm test -- test\/request\.test\.js$/m);
    assert.match(rendered, /^  - hard: yes$/m);
    assert.match(rendered, /^  - rules: M2, M3$/m);
  });

  it("formats multiple tasks separated by blank lines", () => {
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "First task",
        role: "bonesetter",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["package.json"],
        filesInScope: ["package.json"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M1"],
        ruleIds: ["M1"],
        line: 1,
      },
      {
        id: "T2",
        title: "Second task",
        role: "soul-stitcher",
        dependencies: ["T1"],
        depends: ["T1"],
        dependsOn: ["T1"],
        files: ["index.js"],
        filesInScope: ["index.js"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: true,
        hardFlag: true,
        hardRaw: "yes",
        rules: ["M2"],
        ruleIds: ["M2"],
        line: 8,
      },
    ];

    const rendered = renderPact(tasks);
    assert.ok(rendered.includes("- [ ] T1. First task\n"));
    assert.ok(rendered.includes("\n\n- [ ] T2. Second task\n"));
    assert.ok(rendered.endsWith("\n"));
  });

  it("handles various input container shapes (array, object with tasks, parse result)", () => {
    const tasks: PactTask[] = [
      {
        id: "T1",
        title: "Only task",
        role: "bonesetter",
        dependencies: [],
        depends: [],
        dependsOn: [],
        files: ["package.json"],
        filesInScope: ["package.json"],
        acceptanceCommand: "npm test",
        accept: "npm test",
        hard: false,
        hardFlag: false,
        hardRaw: "no",
        rules: ["M1"],
        ruleIds: ["M1"],
        line: 1,
      },
    ];

    const fromArray = renderPact(tasks);
    const fromObject = renderPact({ tasks });
    const fromParseResult = renderPact({ ok: true, tasks, errors: [] });

    assert.equal(fromArray, fromObject);
    assert.equal(fromArray, fromParseResult);
    assert.equal(renderTasks(tasks), fromArray);
    assert.equal(renderTasksMd(tasks), fromArray);
  });

  it("returns empty string on null, undefined, or empty task list", () => {
    assert.equal(renderPact(null), "");
    assert.equal(renderPact(undefined), "");
    assert.equal(renderPact([]), "");
    assert.equal(renderPact({ tasks: [] }), "");
  });

  it("sanitizes multiline titles into single-line titles", () => {
    const task = {
      id: "T1",
      title: "First line\nSecond line\r\nThird line",
      role: "bonesetter",
      depends: [],
      files: ["package.json"],
      accept: "npm test",
      hard: false,
      rules: [],
    };
    const rendered = renderTask(task);
    assert.match(rendered, /^- \[ \] T1\. First line Second line Third line$/m);
  });
});

describe("Pact Renderer: Round-Trip Idempotence (Requirements 12.12, 12.13)", () => {
  it("achieves round-trip idempotence on complex multi-task pact", () => {
    const originalMarkdown = `- [ ] T1. Update dependencies
  - role: bonesetter
  - depends:
  - files: package.json
  - accept: npm test
  - hard: no
  - rules: M1

- [ ] T2. Migrate request calls
  - role: soul-stitcher
  - depends: T1
  - files: lib/request.js
  - accept: npm test
  - hard: yes
  - rules: M2
`;

    const parse1 = parsePact(originalMarkdown);
    assert.equal(parse1.ok, true);
    if (!parse1.ok) return;

    const rendered1 = renderPact(parse1.tasks);
    const parse2 = parsePact(rendered1);
    assert.equal(parse2.ok, true);
    if (!parse2.ok) return;

    const rendered2 = renderPact(parse2.tasks);
    assert.equal(rendered1, rendered2);

    // Deep equality of parsed task structures
    assert.equal(parse1.tasks.length, parse2.tasks.length);
    for (let i = 0; i < parse1.tasks.length; i++) {
      assert.equal(parse1.tasks[i].id, parse2.tasks[i].id);
      assert.equal(parse1.tasks[i].title, parse2.tasks[i].title);
      assert.equal(parse1.tasks[i].role, parse2.tasks[i].role);
      assert.deepEqual(parse1.tasks[i].dependencies, parse2.tasks[i].dependencies);
      assert.deepEqual(parse1.tasks[i].files, parse2.tasks[i].files);
      assert.equal(parse1.tasks[i].acceptanceCommand, parse2.tasks[i].acceptanceCommand);
      assert.equal(parse1.tasks[i].hard, parse2.tasks[i].hard);
      assert.deepEqual(parse1.tasks[i].rules, parse2.tasks[i].rules);
    }
  });

  it("fast-check property test: round-trip idempotence on arbitrary valid generated Pacts (Requirement 12.13)", () => {
    // Generate valid tasks in topological order ensuring acyclic DAG
    const safeTitleArb = fc
      .stringMatching(/^[a-zA-Z0-9 _-]{3,40}$/)
      .filter((s) => s.trim().length > 0);

    const safeFileArb = fc.constantFrom(
      "package.json",
      "lib/index.ts",
      "src/core.js",
      "test/unit.test.ts",
      "config/settings.json",
      "lib/request.js"
    );

    const safeCommandArb = fc.constantFrom(
      "npm test",
      "npm run build",
      "node test.js",
      "npm run lint"
    );

    const roleArb = fc.constantFrom("bonesetter" as const, "soul-stitcher" as const);
    const hardArb = fc.boolean();
    const rulesArb = fc.subarray(["M1", "M2", "M3", "M4", "M5", "M6"] as const);

    const pactTasksArb = fc
      .integer({ min: 1, max: 6 })
      .chain((taskCount) => {
        const taskArbs = [];
        for (let i = 1; i <= taskCount; i++) {
          const taskId = `T${i}`;
          // Allowed dependencies are only strictly earlier tasks (guarantees DAG without cycles)
          const earlierTaskIds = Array.from({ length: i - 1 }, (_, idx) => `T${idx + 1}`);
          const depsArb = fc.subarray(earlierTaskIds);

          taskArbs.push(
            fc.record({
              id: fc.constant(taskId),
              title: safeTitleArb,
              role: roleArb,
              dependencies: depsArb,
              files: fc.array(safeFileArb, { minLength: 1, maxLength: 3 }),
              acceptanceCommand: safeCommandArb,
              hard: hardArb,
              rules: rulesArb,
            })
          );
        }
        return fc.tuple(...taskArbs);
      });

    fc.assert(
      fc.property(pactTasksArb, (generatedTasks) => {
        // Map to PactTask shape
        const pactTasks: PactTask[] = generatedTasks.map((g, idx) => ({
          id: g.id,
          title: g.title.trim(),
          role: g.role,
          dependencies: g.dependencies,
          depends: g.dependencies,
          dependsOn: g.dependencies,
          files: g.files,
          filesInScope: g.files,
          acceptanceCommand: g.acceptanceCommand,
          accept: g.acceptanceCommand,
          hard: g.hard,
          hardFlag: g.hard,
          hardRaw: g.hard ? "yes" : "no",
          rules: g.rules,
          ruleIds: g.rules,
          line: idx * 7 + 1,
        }));

        // 1. Render to markdown
        const markdown = renderPact(pactTasks);
        assert.ok(markdown.length > 0);

        // 2. Parse back
        const parseResult = parsePact(markdown);
        assert.equal(parseResult.ok, true, `Parse failed on rendered markdown: ${markdown}`);
        if (!parseResult.ok) return;

        // 3. Compare tasks structurally
        assert.equal(parseResult.tasks.length, pactTasks.length);
        for (let i = 0; i < pactTasks.length; i++) {
          const expected: PactTask = pactTasks[i];
          const actual: PactTask = parseResult.tasks[i];
          assert.equal(actual.id, expected.id);
          assert.equal(actual.title, expected.title);
          assert.equal(actual.role, expected.role);
          assert.deepEqual(actual.dependencies, expected.dependencies);
          assert.deepEqual(actual.files, expected.files);
          assert.equal(actual.acceptanceCommand, expected.acceptanceCommand);
          assert.equal(actual.hard, expected.hard);
          assert.deepEqual(actual.rules, expected.rules);
        }

        // 4. Render again and assert byte-for-byte idempotence
        const secondRender = renderPact(parseResult.tasks);
        assert.equal(secondRender, markdown);
      }),
      { numRuns: 50 }
    );
  });
});
