import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRATCH = "/tmp/claude-1000/-home-shuv-dotfiles-opencode-v2/d7a9aa0f-07d6-4f16-9a44-2a6cf94cf825/scratchpad"

test("package root remains a V1 plugin factory", async () => {
  const entrypoint = await import("../dist/index.js")
  assert.equal(typeof entrypoint.default, "function")
})

test("V2 is isolated behind its explicit entrypoint", async () => {
  const entrypoint = await import("../dist/v2.js")
  assert.equal(entrypoint.default.id, "opencode-anthropic-oauth")
  assert.equal(typeof entrypoint.default.setup, "function")
})

// Packs the plugin exactly as it would publish, then imports each declared
// export map entry from the extracted tarball to catch packaging regressions
// (missing files, wrong exports, or V2-only deps leaking into the V1 path).
function packAndExtract() {
  mkdirSync(SCRATCH, { recursive: true })
  const workdir = mkdtempSync(join(SCRATCH, "pack-"))
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", workdir], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim().split("\n").pop()
  const extractDir = join(workdir, "extract")
  mkdirSync(extractDir, { recursive: true })
  execFileSync("tar", ["-xzf", join(workdir, tarball), "-C", extractDir])
  const pkgDir = join(extractDir, "package")
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"))
  const resolve = (subpath) => {
    const target = manifest.exports[subpath].import.replace(/^\.\//, "")
    return pathToFileURL(join(pkgDir, target)).href
  }
  return { pkgDir, resolve }
}

test("packed '.' entrypoint imports under a V1 loader without any V2-only deps", async () => {
  // Extracted into an isolated dir with NO node_modules: the V1 entry must not
  // reach for effect / @ai-sdk/anthropic / the V2 module, or this import throws.
  const { resolve } = packAndExtract()
  const v1 = await import(resolve("."))
  assert.equal(typeof v1.default, "function")
})

test("packed './v2' entrypoint exports the stable plugin id", async () => {
  const { pkgDir, resolve } = packAndExtract()
  // V2 has real external deps; make them resolvable exactly as an install would.
  symlinkSync(join(repoRoot, "node_modules"), join(pkgDir, "node_modules"), "dir")
  const v2 = await import(resolve("./v2"))
  assert.equal(v2.default.id, "opencode-anthropic-oauth")
  assert.equal(typeof v2.default.setup, "function")
})
