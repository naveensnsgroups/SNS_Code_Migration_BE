import glob from 'fast-glob';
import path from 'path';
import { FileNode } from '../types.js';

/**
 * Scans a project directory and builds a recursive tree structure of FileNode items.
 * Ignores binary folders, node_modules, git, and next.js build files.
 */
export async function scanProjectDirectory(dirPath: string): Promise<{ fileTree: FileNode[]; fileList: string[] }> {
  // Use fast-glob to scan the directory. We look for all files recursively.
  const entries = await glob('**/*', {
    cwd: dirPath,
    onlyFiles: true,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/*.log',
      '**/*.png',
      '**/*.jpg',
      '**/*.jpeg',
      '**/*.gif',
      '**/*.ico',
      '**/*.pdf',
    ],
    dot: true,
  });

  const fileTree = buildTreeFromPaths(entries);
  return { fileTree, fileList: entries.sort() };
}

/**
 * Helper to build a recursive FileNode tree from a flat list of relative file paths.
 */
function buildTreeFromPaths(paths: string[]): FileNode[] {
  const root: FileNode[] = [];

  for (const rawPath of paths) {
    const normalizedPath = rawPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const partPath = parts.slice(0, i + 1).join('/');

      // Check if folder or file already exists in current level
      let existingNode = currentLevel.find(node => node.name === part);

      if (!existingNode) {
        existingNode = {
          name: part,
          path: partPath,
          type: isLast ? 'file' : 'directory',
        };
        if (!isLast) {
          existingNode.children = [];
        }
        currentLevel.push(existingNode);
      }

      if (!isLast && existingNode.children) {
        currentLevel = existingNode.children;
      }
    }
  }

  // Helper to sort directory items (directories first, then files alphabetically)
  function sortTree(nodes: FileNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) {
        sortTree(node.children);
      }
    }
  }

  sortTree(root);
  return root;
}

// =============================================================================
//  computeFilteredFileCount — Source-Only File Count for INITIAL_FILE_COUNT
// =============================================================================
//
//  Counts ONLY files that Phase 1 (Discovery) will actually index.
//  This count becomes INITIAL_FILE_COUNT in the Discovery prompt.
//  Using the raw fileList.length causes the Discovery cross-check to fire
//  incorrectly (inflated count includes lock files, .d.ts, bytecode, etc.)
//
//  Excludes:
//    - Generated:   *.d.ts, *.map, *.min.js, *.min.css, *.pyc, *.class
//    - Objects:     *.o, *.obj, *.a, *.lib, *.so, *.dll
//    - Lock files:  package-lock.json, yarn.lock, go.sum, Cargo.lock, etc.
//    - Virtual envs/build dirs: vendor/, __pycache__/, venv/, target/, etc.
//
//  Does NOT exclude: config files, test files, schema files, source code.
//  Those ARE counted because Discovery will index them.

const SOURCE_EXCLUDE_SUFFIXES: string[] = [
  '.d.ts',    // TypeScript declarations (generated)
  '.map',     // Source maps (generated)
  '.min.js',  // Minified JS (generated)
  '.min.css', // Minified CSS (generated)
  '.pyc',     // Python bytecode
  '.class',   // Java/Kotlin bytecode
  '.o',       // Compiled objects (C/C++/Rust)
  '.obj',     // Compiled objects (Windows)
  '.a',       // Static libraries
  '.lib',     // Windows static libraries
  '.so',      // Linux shared libraries
  '.dll',     // Windows dynamic libraries
];

const SOURCE_EXCLUDE_FILENAMES = new Set<string>([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'go.sum',         // Go checksum file — not source
]);

const SOURCE_EXCLUDE_DIR_SEGMENTS: string[] = [
  '/vendor/',       // Go vendor, PHP vendor
  '/__pycache__/',  // Python bytecode cache
  '/venv/',         // Python virtual env
  '/.venv/',        // Python virtual env (dot prefix)
  '/target/',       // Java Maven / Rust cargo build output
  '/.gradle/',      // Gradle build cache
  '/.m2/',          // Maven local repository
  '/coverage/',     // Test coverage output
  '/.nyc_output/',  // Node.js coverage output
  '/bin/',          // Compiled binary output (.NET / Go)
  '/obj/',          // .NET compiled objects
  '/_build/',       // Elixir Mix build output
  '/deps/',         // Elixir Mix dependencies
  '/.dart_tool/',   // Dart tool cache
  '/.build/',       // Swift package build
];

export function computeFilteredFileCount(fileList: string[]): number {
  return fileList.filter(filePath => {
    const normalized     = filePath.replace(/\\/g, '/');
    const basename       = normalized.split('/').pop() ?? '';
    const lower          = normalized.toLowerCase();
    const withBoundaries = `/${normalized}/`;

    // Exclude by exact filename (lock files, checksum files)
    if (SOURCE_EXCLUDE_FILENAMES.has(basename)) return false;

    // Exclude by suffix — handles compound extensions (.d.ts, .min.js)
    for (const suffix of SOURCE_EXCLUDE_SUFFIXES) {
      if (lower.endsWith(suffix)) return false;
    }

    // Exclude by directory segment
    for (const segment of SOURCE_EXCLUDE_DIR_SEGMENTS) {
      if (withBoundaries.includes(segment)) return false;
    }

    return true;
  }).length;
}

// =============================================================================
//  findManifestFiles — Pre-find Project Descriptors (TypeScript, 0 LLM turns)
// =============================================================================
//
//  Finds all project descriptor files from the already-scanned fileList.
//  TypeScript does this deterministically — eliminates 2 LLM turns
//  (getWorkspaceDirectoryStructure + findFilesByPattern) from the scanner.
//
//  Results are injected into the scanner user prompt so the LLM only
//  needs to call getFileContent (read), not findFilesByPattern (search).
//
//  Covers 30+ language ecosystems using exact name match or regex pattern.
//  Max depth: 3 — project descriptors are never buried deep in source trees.

type ManifestPattern = string | RegExp;

const MANIFEST_PATTERNS: ManifestPattern[] = [
  // ── Node.js / JavaScript / TypeScript ─────────────────────────────────────
  'package.json',

  // ── Python ────────────────────────────────────────────────────────────────
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Pipfile',
  'setup.cfg',

  // ── Java / Kotlin ─────────────────────────────────────────────────────────
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',

  // ── Go ────────────────────────────────────────────────────────────────────
  'go.mod',

  // ── Rust ──────────────────────────────────────────────────────────────────
  'Cargo.toml',

  // ── PHP ───────────────────────────────────────────────────────────────────
  'composer.json',

  // ── Ruby ──────────────────────────────────────────────────────────────────
  'Gemfile',

  // ── .NET (C# / F# / VB) ──────────────────────────────────────────────────
  /\.csproj$/,
  /\.sln$/,
  /\.fsproj$/,
  /\.vbproj$/,

  // ── Elixir ────────────────────────────────────────────────────────────────
  'mix.exs',

  // ── Dart / Flutter ────────────────────────────────────────────────────────
  'pubspec.yaml',

  // ── Scala ─────────────────────────────────────────────────────────────────
  'build.sbt',

  // ── Clojure ───────────────────────────────────────────────────────────────
  'project.clj',
  'deps.edn',

  // ── Haskell ───────────────────────────────────────────────────────────────
  /\.cabal$/,
  'stack.yaml',

  // ── Swift ─────────────────────────────────────────────────────────────────
  'Package.swift',

  // ── C / C++ ───────────────────────────────────────────────────────────────
  'CMakeLists.txt',
  'conanfile.txt',
  'vcpkg.json',

  // ── Julia ─────────────────────────────────────────────────────────────────
  'Project.toml',

  // ── Deno / Bun ────────────────────────────────────────────────────────────
  'deno.json',
  'deno.jsonc',
  'bunfig.toml',

  // ── Zig ───────────────────────────────────────────────────────────────────
  'build.zig',

  // ── Nim ───────────────────────────────────────────────────────────────────
  /\.nimble$/,

  // ── Crystal ───────────────────────────────────────────────────────────────
  'shard.yml',

  // ── Erlang ────────────────────────────────────────────────────────────────
  'rebar.config',
  'rebar3.config',

  // ── R (packages) ──────────────────────────────────────────────────────────
  'DESCRIPTION',

  // ── Infrastructure ────────────────────────────────────────────────────────
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  /\.tf$/,              // Terraform root module files

  // ── Database / App Configuration files ────────────────────────────────────
  // These reveal database engine when dependency files don't (e.g. SQLite in Django
  // is built-in — requirements.txt has no sqlite3 entry, settings.py does).
  'settings.py',              // Django: DATABASES = { ENGINE: 'sqlite3' | 'mysql' | 'postgresql' }
  'application.properties',   // Spring Boot: spring.datasource.url=jdbc:mysql://...
  'application.yml',          // Spring Boot (YAML): datasource.url
  'application.yaml',         // Spring Boot (YAML alt)
  /^config\/database\.yml$/,  // Rails: adapter: postgresql / mysql2 / sqlite3
  '.env',                     // Node/Laravel/any: DB_CONNECTION=, DATABASE_URL=, MONGO_URI=
  '.env.example',             // Committed env template — often has DB vars without secrets
];

// Never treat lock/checksum files as manifests (no useful stack info)
const MANIFEST_EXCLUDE_NAMES = new Set<string>([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml',
  'poetry.lock', 'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'go.sum',
]);

export function findManifestFiles(fileList: string[]): string[] {
  const found: string[] = [];

  for (const filePath of fileList) {
    const normalized = filePath.replace(/\\/g, '/');
    const basename   = normalized.split('/').pop() ?? '';
    const depth      = normalized.split('/').length - 1;

    // Manifests are at most 3 levels deep (root / packages/sub / packages/sub/sub)
    if (depth > 3) continue;

    // Never include lock/checksum files as manifests
    if (MANIFEST_EXCLUDE_NAMES.has(basename)) continue;

    // Match against manifest patterns (exact name or regex)
    for (const pattern of MANIFEST_PATTERNS) {
      const matched = typeof pattern === 'string'
        ? basename === pattern
        : pattern.test(basename);

      if (matched) {
        found.push(normalized);
        break; // one match per file path
      }
    }
  }

  return found;
}
