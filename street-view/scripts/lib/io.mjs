// These helpers keep the file-based Street View proof of concept small and predictable.
import { mkdir, readFile, writeFile, access } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

export function resolveFrom(importMetaUrl, ...parts) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), ...parts);
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, text, "utf8");
}
