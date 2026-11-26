import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import {
  extractArchive,
  ArchiveError,
  ArchiveFileMap,
} from "../../lib/grimoire/archive";

interface SyntheticTarEntry {
  name: string;
  content?: string | Uint8Array;
  mode?: number;
  typeflag?: string;
  linkname?: string;
  corruptChecksum?: boolean;
}

function buildSyntheticTar(entries: SyntheticTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    const mode = entry.mode ?? (entry.typeflag === "5" ? 0o755 : 0o644);
    header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");

    const contentBuf = entry.content
      ? typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : Buffer.from(entry.content)
      : Buffer.alloc(0);

    header.write(
      contentBuf.length.toString(8).padStart(11, "0") + "\0",
      124,
      12,
      "ascii"
    );
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.typeflag ?? "0", 156, 1, "ascii");
    if (entry.linkname) {
      header.write(entry.linkname, 157, 100, "utf8");
    }
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    if (entry.corruptChecksum) {
      header.write("777777\0 ", 148, 8, "ascii");
    } else {
      let sum = 0;
      for (let i = 0; i < 512; i++) {
        sum += header[i];
      }
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    }

    blocks.push(header);
    if (contentBuf.length > 0) {
      blocks.push(contentBuf);
      const pad = (512 - (contentBuf.length % 512)) % 512;
      if (pad > 0) {
        blocks.push(Buffer.alloc(pad));
      }
    }
  }

  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function buildGzipArchive(entries: SyntheticTarEntry[]): Buffer {
  return zlib.gzipSync(buildSyntheticTar(entries));
}

describe("archive: extractArchive", () => {
  describe("Size limits with small synthetic archives (Requirement 2.8)", () => {
    it("fails with TOO_LARGE when compressed bytes exceed maxCompressedBytes", async () => {
      const gz = buildGzipArchive([
        { name: "repo/file.txt", content: "some text content" },
      ]);
      // Set compressed limit lower than gz size
      const result = await extractArchive(Readable.from(gz), {
        maxCompressedBytes: 20,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "TOO_LARGE");
        assert.match(result.message, /compressed size/);
      }
    });

    it("fails with TOO_LARGE when decompressed bytes exceed maxDecompressedBytes", async () => {
      const largeContent = "A".repeat(500);
      const gz = buildGzipArchive([
        { name: "repo/large.txt", content: largeContent },
      ]);
      const result = await extractArchive(Readable.from(gz), {
        maxDecompressedBytes: 200,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "TOO_LARGE");
        assert.match(result.message, /decompressed size/);
      }
    });

    it("fails with TOO_LARGE when entry count exceeds maxEntries", async () => {
      const gz = buildGzipArchive([
        { name: "repo/1.txt", content: "1" },
        { name: "repo/2.txt", content: "2" },
        { name: "repo/3.txt", content: "3" },
      ]);
      const result = await extractArchive(Readable.from(gz), {
        maxEntries: 2,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "TOO_LARGE");
        assert.match(result.message, /entry count/);
      }
    });

    it("throws ArchiveError with TOO_LARGE when throwOnError is true", async () => {
      const gz = buildGzipArchive([
        { name: "repo/1.txt", content: "1" },
        { name: "repo/2.txt", content: "2" },
      ]);
      await assert.rejects(
        async () => {
          await extractArchive(Readable.from(gz), {
            maxEntries: 1,
            throwOnError: true,
          });
        },
        (err: unknown) => {
          assert(err instanceof ArchiveError);
          assert.equal(err.code, "TOO_LARGE");
          return true;
        }
      );
    });
  });

  describe("Symlink, hard link, and traversal rejection (Requirement 2.9)", () => {
    it("rejects absolute paths with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        { name: "/etc/passwd", content: "root:x:0:0::/root:/bin/bash" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /unsafe path/);
      }
    });

    it("rejects backslash absolute paths with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        { name: "\\windows\\system32\\config", content: "data" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /unsafe path/);
      }
    });

    it("rejects Windows drive letters with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        { name: "C:/windows/system32", content: "data" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /unsafe path/);
      }
    });

    it("rejects parent directory traversal .. with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        { name: "repo/../secret.txt", content: "secret" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /unsafe path/);
      }
    });

    it("rejects symlink entries with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        {
          name: "repo/symlink.txt",
          typeflag: "2",
          linkname: "/etc/passwd",
        },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /symlink/);
      }
    });

    it("rejects hard link entries with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        {
          name: "repo/hardlink.txt",
          typeflag: "1",
          linkname: "repo/target.txt",
        },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /hard link/);
      }
    });

    it("rejects special devices and fifos with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        { name: "repo/fifo", typeflag: "6" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /special device or FIFO/);
      }
    });

    it("rejects corrupted tar header checksums with ARCHIVE_UNSAFE", async () => {
      const gz = buildGzipArchive([
        {
          name: "repo/corrupt.txt",
          content: "data",
          corruptChecksum: true,
        },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "ARCHIVE_UNSAFE");
        assert.match(result.message, /checksum/);
      }
    });
  });

  describe("Git LFS pointer pass-through (Requirement 2.10)", () => {
    it("identifies Git LFS pointer files as binary and not scanned", async () => {
      const lfsContent =
        "version https://git-lfs.github.com/spec/v1\n" +
        "oid sha256:4d7a214614ab2935c943f9e0ff69d22eeaa0f31498ecdc011dec383dd0ecf113\n" +
        "size 123456\n";

      const gz = buildGzipArchive([
        { name: "repo/model.bin", content: lfsContent },
        { name: "repo/index.js", content: "console.log('hi');" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        const lfsEntry = result.get("model.bin");
        assert.ok(lfsEntry);
        assert.equal(lfsEntry.isLfs, true);
        assert.equal(lfsEntry.isBinary, true);
        assert.equal(lfsEntry.text, undefined);

        const jsEntry = result.get("index.js");
        assert.ok(jsEntry);
        assert.equal(jsEntry.isLfs, false);
        assert.equal(jsEntry.isBinary, false);
        assert.equal(jsEntry.text, "console.log('hi');");
      }
    });
  });

  describe("UTF-8 encoding validation (Requirement 2.12)", () => {
    it("marks valid UTF-8 text file with encodingUnsupported = false", async () => {
      const gz = buildGzipArchive([
        { name: "repo/valid.txt", content: "Hello world!" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        const entry = result.get("valid.txt");
        assert.ok(entry);
        assert.equal(entry.isBinary, false);
        assert.equal(entry.encodingUnsupported, false);
        assert.equal(entry.encoding_unsupported, false);
        assert.equal(entry.text, "Hello world!");
      }
    });

    it("marks invalid UTF-8 text file with encoding_unsupported", async () => {
      const nonUtf8Bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x81]);
      const gz = buildGzipArchive([
        { name: "repo/nonutf8.txt", content: nonUtf8Bytes },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        const entry = result.get("nonutf8.txt");
        assert.ok(entry);
        assert.equal(entry.isBinary, false);
        assert.equal(entry.encodingUnsupported, true);
        assert.equal(entry.encoding_unsupported, true);
        assert.equal(entry.text, undefined);
      }
    });

    it("detects binary files containing null bytes", async () => {
      const binaryBytes = new Uint8Array([0x01, 0x02, 0x00, 0x03, 0x04]);
      const gz = buildGzipArchive([
        { name: "repo/data.bin", content: binaryBytes },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        const entry = result.get("data.bin");
        assert.ok(entry);
        assert.equal(entry.isBinary, true);
        assert.equal(entry.text, undefined);
      }
    });
  });

  describe("Submodule exclusion and directory stripping (Requirement 2.11)", () => {
    it("excludes files within submodule paths declared in .gitmodules", async () => {
      const gitmodulesContent =
        '[submodule "deps/ext"]\n' +
        "\tpath = deps/ext\n" +
        "\turl = https://github.com/example/ext.git\n";

      const gz = buildGzipArchive([
        { name: "repo/.gitmodules", content: gitmodulesContent },
        { name: "repo/index.js", content: "console.log(1);" },
        { name: "repo/deps/ext/sub.js", content: "console.log(2);" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.has("index.js"));
        assert.ok(result.has(".gitmodules"));
        assert.equal(result.has("deps/ext/sub.js"), false);
      }
    });

    it("skips gitlink entries with mode 0o160000", async () => {
      const gz = buildGzipArchive([
        { name: "repo/submodule-link", mode: 0o160000, content: "" },
        { name: "repo/file.txt", content: "main repo file" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.has("file.txt"));
        assert.equal(result.has("submodule-link"), false);
      }
    });

    it("strips common leading directory by default", async () => {
      const gz = buildGzipArchive([
        { name: "project-master/src/main.js", content: "code" },
        { name: "project-master/package.json", content: "{}" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.has("src/main.js"));
        assert.ok(result.has("package.json"));
      }
    });

    it("preserves leading directory when stripLeadingDir is false", async () => {
      const gz = buildGzipArchive([
        { name: "root/file.txt", content: "test" },
      ]);
      const result = await extractArchive(Readable.from(gz), {
        stripLeadingDir: false,
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.has("root/file.txt"));
      }
    });
  });

  describe("Timeout and AbortSignal handling (Requirement 2.13)", () => {
    it("handles pre-aborted signal with TIMEOUT", async () => {
      const controller = new AbortController();
      controller.abort();
      const gz = buildGzipArchive([
        { name: "repo/file.txt", content: "content" },
      ]);
      const result = await extractArchive(Readable.from(gz), {
        signal: controller.signal,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "TIMEOUT");
      }
    });

    it("handles watchdog timeout with slow stream", async () => {
      const slowStream = new Readable({
        read() {
          // Never push data to simulate stalled stream
        },
      });
      const result = await extractArchive(slowStream, {
        timeoutMs: 50,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, "TIMEOUT");
      }
    });
  });

  describe("ArchiveFileMap interface", () => {
    it("provides Map interface, totalEntries, and fileList", async () => {
      const gz = buildGzipArchive([
        { name: "repo/a.txt", content: "alpha" },
        { name: "repo/b.txt", content: "beta" },
      ]);
      const result = await extractArchive(Readable.from(gz));

      assert.equal(result.ok, true);
      if (result.ok) {
        assert(result instanceof ArchiveFileMap);
        assert.equal(result.size, 2);
        assert.equal(result.totalEntries, 2);
        assert.equal(result.fileList.length, 2);
        assert.equal(result.fileTree, result);
        assert.equal(result.files, result);
        assert.equal(result.get("a.txt")?.text, "alpha");
        assert.equal(result.get("repo/a.txt")?.text, "alpha");
        assert.equal(result.has("a.txt"), true);
        assert.equal(result.has("nonexistent.txt"), false);
      }
    });
  });
});
