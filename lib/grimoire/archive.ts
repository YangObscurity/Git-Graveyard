import { Readable } from "node:stream";
import * as zlib from "node:zlib";

export type ArchiveErrorCode = "TOO_LARGE" | "ARCHIVE_UNSAFE" | "TIMEOUT";

export interface ArchiveFileEntry {
  path: string;
  rawPath: string;
  bytes: Uint8Array;
  text?: string;
  isBinary: boolean;
  isLfs: boolean;
  encodingUnsupported: boolean;
  encoding_unsupported: boolean;
}

export interface ExtractArchiveOptions {
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxEntries?: number;
  timeoutMs?: number;
  stripComponents?: number;
  stripLeadingDir?: boolean;
  signal?: AbortSignal;
  throwOnError?: boolean;
}

export class ArchiveError extends Error {
  readonly ok = false as const;
  readonly code: ArchiveErrorCode;
  readonly reason?: string;

  constructor(code: ArchiveErrorCode, message?: string, reason?: string) {
    super(message ?? code);
    this.name = "ArchiveError";
    this.code = code;
    this.reason = reason;
    Object.setPrototypeOf(this, ArchiveError.prototype);
  }
}

export interface ExtractArchiveError {
  ok: false;
  code: ArchiveErrorCode;
  message: string;
  reason?: string;
}

export class ArchiveFileMap extends Map<string, ArchiveFileEntry> {
  readonly ok = true as const;
  readonly files: this = this;
  readonly fileTree: this = this;
  totalEntries = 0;
  compressedBytes = 0;
  decompressedBytes = 0;

  get fileList(): ArchiveFileEntry[] {
    return Array.from(this.values());
  }

  override get(key: string): ArchiveFileEntry | undefined {
    const direct = super.get(key);
    if (direct !== undefined) {
      return direct;
    }
    for (const entry of this.values()) {
      if (entry.rawPath === key || entry.path === key) {
        return entry;
      }
    }
    return undefined;
  }

  override has(key: string): boolean {
    if (super.has(key)) {
      return true;
    }
    for (const entry of this.values()) {
      if (entry.rawPath === key || entry.path === key) {
        return true;
      }
    }
    return false;
  }
}

export type ExtractArchiveResult = ArchiveFileMap | ExtractArchiveError;
export type ArchiveResult = ExtractArchiveResult;

const DEFAULT_MAX_COMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_MAX_DECOMPRESSED_BYTES = 60 * 1024 * 1024; // 60 MB
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_TIMEOUT_MS = 20000; // 20 seconds
const TAR_BLOCK_SIZE = 512;

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    if (block[i] !== 0) {
      return false;
    }
  }
  return true;
}

function verifyTarChecksum(block: Buffer): boolean {
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsignedSum += b;
    signedSum += b >= 128 ? b - 256 : b;
  }
  const chksumStr = block
    .subarray(148, 156)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!chksumStr) {
    return false;
  }
  const expected = parseInt(chksumStr, 8);
  if (isNaN(expected)) {
    return false;
  }
  return unsignedSum === expected || signedSum === expected;
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const str = buf
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!str) {
    return 0;
  }
  const val = parseInt(str, 8);
  return isNaN(val) ? 0 : val;
}

function parseTarSize(buf: Buffer, offset: number, length: number): number {
  if ((buf[offset] & 0x80) !== 0) {
    let size = buf[offset] & 0x7f;
    for (let i = 1; i < length; i++) {
      size = size * 256 + buf[offset + i];
    }
    return size;
  }
  return parseOctal(buf, offset, length);
}

function parseNullTerminatedString(
  buf: Buffer,
  offset: number,
  length: number
): string {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(offset, end).toString("utf8");
}

function isUnsafePath(p: string): boolean {
  if (!p) {
    return false;
  }
  if (p.startsWith("/") || p.startsWith("\\")) {
    return true;
  }
  if (/^[a-zA-Z]:[/\\]?/.test(p)) {
    return true;
  }
  const segments = p.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === "..") {
      return true;
    }
  }
  return false;
}

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  normalized = normalized.replace(/^\.?\/+/, "");
  normalized = normalized.replace(/\/+/g, "/");
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function isGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.length < 50 || bytes.length > 2000) {
    return false;
  }
  const prefix = Buffer.from(bytes.subarray(0, 45)).toString("utf8");
  if (!prefix.startsWith("version https://git-lfs.github.com/spec/v1")) {
    return false;
  }
  const text = Buffer.from(bytes).toString("utf8");
  return text.includes("oid sha256:");
}

function isBinaryFile(bytes: Uint8Array): boolean {
  const checkLen = Math.min(bytes.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

function isGitlinkMode(mode: number): boolean {
  return (mode & 0o170000) === 0o160000;
}

function parseGitmodules(content: string): string[] {
  const paths: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
    if (match) {
      const p = match[1].trim().replace(/^\/+|\/+$/g, "");
      if (p) {
        paths.push(p);
      }
    }
  }
  return paths;
}

function determineLeadingPrefix(paths: string[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  let commonPrefix: string | null = null;
  for (const p of paths) {
    const slashIndex = p.indexOf("/");
    if (slashIndex === -1) {
      return null;
    }
    const firstSegment = p.slice(0, slashIndex);
    if (commonPrefix === null) {
      commonPrefix = firstSegment;
    } else if (commonPrefix !== firstSegment) {
      return null;
    }
  }
  return commonPrefix;
}

function stripLeadingComponent(p: string): string {
  const slashIndex = p.indexOf("/");
  if (slashIndex === -1) {
    return p;
  }
  return p.slice(slashIndex + 1);
}

class TarStreamReader {
  private queue: Buffer[] = [];
  private available = 0;
  private ended = false;
  private error: Error | null = null;
  private waitResolve: (() => void) | null = null;
  private stream: Readable;

  constructor(stream: Readable) {
    this.stream = stream;

    stream.on("data", (chunk: Buffer) => {
      this.queue.push(chunk);
      this.available += chunk.length;
      if (this.available > 2 * 1024 * 1024) {
        stream.pause();
      }
      if (this.waitResolve) {
        const resolve = this.waitResolve;
        this.waitResolve = null;
        resolve();
      }
    });

    stream.on("end", () => {
      this.ended = true;
      if (this.waitResolve) {
        const resolve = this.waitResolve;
        this.waitResolve = null;
        resolve();
      }
    });

    stream.on("error", (err: Error) => {
      this.error = err;
      this.ended = true;
      if (this.waitResolve) {
        const resolve = this.waitResolve;
        this.waitResolve = null;
        resolve();
      }
    });
  }

  isEnded(): boolean {
    return this.ended && this.available === 0;
  }

  abort(err: Error): void {
    if (this.error === null) {
      this.error = err;
    }
    this.ended = true;
    try {
      this.stream.destroy();
    } catch {
      // ignore
    }
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve();
    }
  }

  async read(numBytes: number): Promise<Buffer | null> {
    while (this.available < numBytes && !this.ended && !this.error) {
      await new Promise<void>((resolve) => {
        this.waitResolve = resolve;
      });
    }

    if (this.error) {
      throw this.error;
    }

    if (this.available === 0 && this.ended) {
      return null;
    }

    if (this.available < numBytes) {
      if (this.available === 0) {
        return null;
      }
      const res = Buffer.concat(this.queue);
      this.queue = [];
      this.available = 0;
      if (this.stream.isPaused()) {
        this.stream.resume();
      }
      return res;
    }

    const result = Buffer.allocUnsafe(numBytes);
    let offset = 0;
    while (offset < numBytes) {
      const first = this.queue[0];
      const needed = numBytes - offset;
      if (first.length <= needed) {
        first.copy(result, offset);
        offset += first.length;
        this.available -= first.length;
        this.queue.shift();
      } else {
        first.copy(result, offset, 0, needed);
        this.queue[0] = first.subarray(needed);
        offset += needed;
        this.available -= needed;
      }
    }

    if (this.available < 1024 * 1024 && this.stream.isPaused()) {
      this.stream.resume();
    }

    return result;
  }
}

interface RawTarEntry {
  path: string;
  bytes: Buffer;
  mode: number;
}

export async function extractArchive(
  input: Readable,
  options?: ExtractArchiveOptions
): Promise<ExtractArchiveResult> {
  const maxCompressedBytes =
    options?.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxDecompressedBytes =
    options?.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const throwOnError = options?.throwOnError ?? false;

  let timer: NodeJS.Timeout | null = null;
  let finished = false;

  const cleanup = () => {
    finished = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  try {
    let compressedBytes = 0;
    let decompressedBytes = 0;
    let entryCount = 0;

    const gunzip = zlib.createGunzip();
    const reader = new TarStreamReader(gunzip);

    let aborted = false;
    const abortWith = (err: ArchiveError) => {
      if (aborted || finished) {
        return;
      }
      aborted = true;
      cleanup();
      try {
        input.destroy();
      } catch {
        // ignore
      }
      reader.abort(err);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!finished) {
          abortWith(new ArchiveError("TIMEOUT", "Archive extraction timed out"));
        }
      }, timeoutMs);
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        cleanup();
        const err = new ArchiveError("TIMEOUT", "Operation aborted");
        if (throwOnError) {
          throw err;
        }
        return err;
      }
      options.signal.addEventListener(
        "abort",
        () => {
          if (!finished) {
            abortWith(new ArchiveError("TIMEOUT", "Operation aborted"));
          }
        },
        { once: true }
      );
    }

    input.on("data", (chunk: Buffer) => {
      compressedBytes += chunk.length;
      if (compressedBytes > maxCompressedBytes) {
        abortWith(
          new ArchiveError(
            "TOO_LARGE",
            `Archive compressed size (${compressedBytes} bytes) exceeds limit of ${maxCompressedBytes} bytes`
          )
        );
      }
    });

    input.on("error", (err: Error) => {
      abortWith(
        new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Input stream error: ${err.message}`
        )
      );
    });

    gunzip.on("data", (chunk: Buffer) => {
      decompressedBytes += chunk.length;
      if (decompressedBytes > maxDecompressedBytes) {
        abortWith(
          new ArchiveError(
            "TOO_LARGE",
            `Archive decompressed size (${decompressedBytes} bytes) exceeds limit of ${maxDecompressedBytes} bytes`
          )
        );
      }
    });

    gunzip.on("error", (err: Error) => {
      abortWith(
        new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Decompression error: ${err.message}`
        )
      );
    });

    input.pipe(gunzip);

    const rawEntries: RawTarEntry[] = [];
    let pendingLongName: string | null = null;
    let paxPath: string | null = null;
    let consecutiveZeroBlocks = 0;

    while (true) {
      const headerBuf = await reader.read(TAR_BLOCK_SIZE);
      if (!headerBuf || headerBuf.length < TAR_BLOCK_SIZE) {
        break;
      }

      if (isZeroBlock(headerBuf)) {
        consecutiveZeroBlocks++;
        if (consecutiveZeroBlocks >= 2) {
          // Reached end of archive marker
          break;
        }
        continue;
      }

      consecutiveZeroBlocks = 0;

      if (!verifyTarChecksum(headerBuf)) {
        throw new ArchiveError(
          "ARCHIVE_UNSAFE",
          "Archive contains corrupted tar header checksum"
        );
      }

      const typeflagByte = headerBuf[156];
      const typeflag =
        typeflagByte === 0 ? "0" : String.fromCharCode(typeflagByte);
      const size = parseTarSize(headerBuf, 124, 12);
      const mode = parseOctal(headerBuf, 100, 8);
      const name = parseNullTerminatedString(headerBuf, 0, 100);
      const magic = parseNullTerminatedString(headerBuf, 257, 6);
      const prefix = magic.startsWith("ustar")
        ? parseNullTerminatedString(headerBuf, 345, 155)
        : "";

      let entryPath = prefix ? `${prefix}/${name}` : name;
      if (pendingLongName !== null) {
        entryPath = pendingLongName;
        pendingLongName = null;
      } else if (paxPath !== null) {
        entryPath = paxPath;
        paxPath = null;
      }

      // Check unsafe links
      if (typeflag === "1") {
        throw new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Archive contains hard link: ${entryPath}`
        );
      }
      if (typeflag === "2" || typeflag === "s") {
        throw new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Archive contains symlink: ${entryPath}`
        );
      }
      if (typeflag === "3" || typeflag === "4" || typeflag === "6") {
        throw new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Archive contains special device or FIFO: ${entryPath}`
        );
      }
      if (typeflag === "K") {
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (size > 0) {
          await reader.read(size);
        }
        if (pad > 0) {
          await reader.read(pad);
        }
        throw new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Archive contains long link: ${entryPath}`
        );
      }

      // GNU Long Name
      if (typeflag === "L") {
        const data = size > 0 ? await reader.read(size) : Buffer.alloc(0);
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (pad > 0) {
          await reader.read(pad);
        }
        if (data) {
          pendingLongName = parseNullTerminatedString(data, 0, data.length);
        }
        continue;
      }

      // PAX Headers
      if (typeflag === "g") {
        if (size > 0) {
          await reader.read(size);
        }
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (pad > 0) {
          await reader.read(pad);
        }
        continue;
      }

      if (typeflag === "x") {
        const data = size > 0 ? await reader.read(size) : Buffer.alloc(0);
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (pad > 0) {
          await reader.read(pad);
        }
        if (data) {
          const paxText = data.toString("utf8");
          const match = paxText.match(/\d+ path=(.+)\n/);
          if (match) {
            paxPath = match[1];
          }
        }
        continue;
      }

      // Check path safety
      if (isUnsafePath(entryPath)) {
        throw new ArchiveError(
          "ARCHIVE_UNSAFE",
          `Archive entry has unsafe path: ${entryPath}`
        );
      }

      entryCount++;
      if (entryCount > maxEntries) {
        throw new ArchiveError(
          "TOO_LARGE",
          `Archive entry count (${entryCount}) exceeds limit of ${maxEntries}`
        );
      }

      // Directory
      if (typeflag === "5" || entryPath.endsWith("/")) {
        if (size > 0) {
          await reader.read(size);
        }
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (pad > 0) {
          await reader.read(pad);
        }
        continue;
      }

      // Regular file ('0' or '\0' or '7')
      if (typeflag === "0" || typeflag === "" || typeflag === "7") {
        const fileBytes =
          size > 0 ? (await reader.read(size)) ?? Buffer.alloc(0) : Buffer.alloc(0);
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (pad > 0) {
          await reader.read(pad);
        }

        // Submodule gitlink check
        if (isGitlinkMode(mode)) {
          continue;
        }

        rawEntries.push({
          path: entryPath,
          bytes: fileBytes,
          mode,
        });
      } else {
        // Unknown or unsupported entry type
        if (size > 0) {
          await reader.read(size);
        }
        const pad = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
        if (pad > 0) {
          await reader.read(pad);
        }
      }
    }

    // Drain remainder to ensure byte limits are validated
    while (!reader.isEnded()) {
      const remainder = await reader.read(65536);
      if (!remainder) {
        break;
      }
    }

    cleanup();

    // Parse .gitmodules for submodule directory paths
    const submodulePaths: string[] = [];
    for (const raw of rawEntries) {
      const norm = normalizePath(raw.path);
      if (norm === ".gitmodules" || norm.endsWith("/.gitmodules")) {
        const gmContent = raw.bytes.toString("utf8");
        const found = parseGitmodules(gmContent);
        for (const f of found) {
          submodulePaths.push(f);
        }
      }
    }

    // Determine strip prefix
    let shouldStripPrefix = false;
    let explicitStripCount = options?.stripComponents;

    if (explicitStripCount === undefined) {
      if (options?.stripLeadingDir === false) {
        explicitStripCount = 0;
      } else if (options?.stripLeadingDir === true) {
        shouldStripPrefix = true;
      } else {
        // Auto-detect common leading directory
        const normalizedPaths = rawEntries.map((e) => normalizePath(e.path));
        const commonDir = determineLeadingPrefix(normalizedPaths);
        if (commonDir !== null) {
          shouldStripPrefix = true;
        }
      }
    }

    const resultMap = new ArchiveFileMap();
    resultMap.totalEntries = entryCount;
    resultMap.compressedBytes = compressedBytes;
    resultMap.decompressedBytes = decompressedBytes;

    for (const raw of rawEntries) {
      let norm = normalizePath(raw.path);

      if (explicitStripCount !== undefined && explicitStripCount > 0) {
        for (let i = 0; i < explicitStripCount; i++) {
          norm = stripLeadingComponent(norm);
        }
      } else if (shouldStripPrefix) {
        norm = stripLeadingComponent(norm);
      }

      // Check if file is inside a submodule path
      let insideSubmodule = false;
      for (const sub of submodulePaths) {
        if (norm === sub || norm.startsWith(`${sub}/`)) {
          insideSubmodule = true;
          break;
        }
      }
      if (insideSubmodule) {
        continue;
      }

      const bytes = new Uint8Array(
        raw.bytes.buffer,
        raw.bytes.byteOffset,
        raw.bytes.byteLength
      );

      const isLfs = isGitLfsPointer(bytes);
      let isBinary = isLfs;
      let text: string | undefined = undefined;
      let encodingUnsupported = false;

      if (!isBinary) {
        if (isBinaryFile(bytes)) {
          isBinary = true;
        } else {
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            encodingUnsupported = true;
          }
        }
      }

      const entry: ArchiveFileEntry = {
        path: norm,
        rawPath: raw.path,
        bytes,
        text,
        isBinary,
        isLfs,
        encodingUnsupported,
        encoding_unsupported: encodingUnsupported,
      };

      resultMap.set(norm, entry);
    }

    return resultMap;
  } catch (err: unknown) {
    cleanup();
    if (err instanceof ArchiveError) {
      if (throwOnError) {
        throw err;
      }
      return {
        ok: false,
        code: err.code,
        message: err.message,
        reason: err.reason,
      };
    }
    const message =
      err instanceof Error ? err.message : String(err);
    const archiveErr = new ArchiveError("ARCHIVE_UNSAFE", message);
    if (throwOnError) {
      throw archiveErr;
    }
    return {
      ok: false,
      code: "ARCHIVE_UNSAFE",
      message: archiveErr.message,
    };
  }
}
