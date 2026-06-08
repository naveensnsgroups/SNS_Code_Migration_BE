import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { writeSessionFile } from './fileWriter.js';
import { ShellExecutor } from './shellExecutor.js';
import { TaskContextManager } from '../session/taskContext.js';
import {
  FILE_CONTENT_FUNCTION_ID,
  GET_WORKSPACE_FILE_LIST_FUNCTION_ID,
  GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID,
  GET_FILE_DIAGNOSTICS_ID,
  SEARCH_IN_WORKSPACE_FUNCTION_ID,
  FIND_FILES_BY_PATTERN_FUNCTION_ID,
  GET_DEPENDENCY_TREE_FUNCTION_ID,
  BATCH_READ_FILES_FUNCTION_ID
} from '../common/workspace-functions.js';

// ── Tool Context ─────────────────────────────────────────────────────────────
// Mirrors snside WorkspaceFunctionScope — provides sessionId, legacyPath,
// modernPath, and optional streaming log callback.

export interface ToolContext {
  sessionId: string;
  legacyPath: string;    // The legacy source project root (read-only workspace)
  modernPath: string;    // The modern output project root (write target)
  onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void;
}

// ── Tool Definition ──────────────────────────────────────────────────────────
// Follows the same shape as snside ToolRequest / ToolProvider interface.
// name        → exact function name the LLM calls
// description → what the LLM reads to decide when to use this tool
// parameters  → JSON Schema describing the arguments
// handler     → async function that runs the actual implementation

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any, context: ToolContext) => Promise<any>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  TOOLS REGISTRY
//  All tool IDs mirror the snside workspace-functions.ts constant names so
//  that prompts copied from the IDE work with zero changes.
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS_REGISTRY: Record<string, ToolDefinition> = {

  // ── getWorkspaceDirectoryStructure ────────────────────────────────────────
  // Mirrors: GetWorkspaceDirectoryStructure (browser/workspace-functions.ts)
  // ID:      GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID
  [GET_WORKSPACE_DIRECTORY_STRUCTURE_FUNCTION_ID]: {
    name: 'getWorkspaceDirectoryStructure',
    description:
      'Retrieves the complete directory tree structure of the legacy workspace as a nested JSON object. ' +
      'Lists only directories (no files), excluding common non-essential directories (node_modules, hidden files, etc.). ' +
      'Useful for getting a high-level overview of project organization. ' +
      'For listing files within a specific directory, use getWorkspaceFileList instead. ' +
      'For finding specific files, use findFilesByPattern.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async (_args: {}, context) => {
      const basePath = path.resolve(context.legacyPath);
      if (!(await fs.pathExists(basePath))) {
        return { error: `Directory does not exist` };
      }

      const EXCLUDE_DIRS = new Set([
        'node_modules', '.git', 'dist', 'build', '__pycache__',
        'vendor', 'target', '.next', 'bin', 'obj', '.venv', 'venv'
      ]);

      async function buildTree(dirPath: string, depth = 0): Promise<any> {
        if (depth > 8) return {};
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        const result: Record<string, any> = {};
        for (const item of items) {
          if (item.isDirectory()) {
            if (EXCLUDE_DIRS.has(item.name) || item.name.startsWith('.')) continue;
            result[item.name] = await buildTree(path.join(dirPath, item.name), depth + 1);
          }
        }
        return result;
      }

      return await buildTree(basePath);
    }
  },

  // ── getWorkspaceFileList ──────────────────────────────────────────────────
  // Mirrors: GetWorkspaceFileList (browser/workspace-functions.ts)
  // ID:      GET_WORKSPACE_FILE_LIST_FUNCTION_ID
  [GET_WORKSPACE_FILE_LIST_FUNCTION_ID]: {
    name: 'getWorkspaceFileList',
    description:
      'Lists files and directories within a specified directory of the legacy workspace. ' +
      'Returns an array of names where directories are suffixed with "/" (e.g. ["src/", "package.json", "README.md"]). ' +
      'Use this to explore directory structure step by step. ' +
      'For finding specific files by pattern, use findFilesByPattern instead. ' +
      'For searching file contents, use searchInWorkspace instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to a directory within the legacy workspace. Use "" or "." for the root.'
        }
      },
      required: ['path']
    },
    handler: async (args: { path: string }, context) => {
      const targetPath = path.resolve(context.legacyPath, args.path || '');
      if (!targetPath.startsWith(path.resolve(context.legacyPath))) {
        throw new Error('Access denied: path is outside the workspace.');
      }
      if (!(await fs.pathExists(targetPath))) {
        return { error: `Directory does not exist: ${args.path || '/'}` };
      }
      const EXCLUDE_DIRS = new Set([
        'node_modules', '.git', 'dist', 'build', '__pycache__',
        'vendor', 'target', '.next', 'bin', 'obj', '.venv', 'venv'
      ]);
      const items = await fs.readdir(targetPath, { withFileTypes: true });
      return items
        .filter(item => {
          if (EXCLUDE_DIRS.has(item.name)) return false;
          if (item.name.startsWith('.') && item.name !== '.env' && item.name !== '.env.example' && item.name !== '.gitignore') return false;
          return true;
        })
        .map(item => item.isDirectory() ? `${item.name}/` : item.name);
    }
  },

  // ── getFileContent ────────────────────────────────────────────────────────
  // Mirrors: FileContentFunction (browser/workspace-functions.ts)
  // ID:      FILE_CONTENT_FUNCTION_ID = 'getFileContent'
  [FILE_CONTENT_FUNCTION_ID]: {
    name: 'getFileContent',
    description:
      'Returns the content of a specified file in the legacy workspace as a raw string. ' +
      'The file path must be relative to the workspace root. ' +
      'Supports optional offset (zero-based line number) and limit (max lines to return) for reading large files in chunks. ' +
      'It is recommended to read the whole file without offset/limit unless you expect it to be very large. ' +
      'If the file is very large (>300 lines), use offset+limit to page through it in chunks of ~200 lines. ' +
      'Do NOT use this for files you have not located yet — use findFilesByPattern or searchInWorkspace first.',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'The relative path to the target file within the legacy workspace (e.g. "src/index.ts", "package.json"). Must be relative to workspace root.'
        },
        offset: {
          type: 'number',
          description: 'Zero-based line offset to start reading from (default: 0). Use with limit to page through large files.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return (default: entire file). Use with offset to read in chunks.'
        }
      },
      required: ['file']
    },
    handler: async (args: { file: string; offset?: number; limit?: number }, context) => {
      if (!args.file) throw new Error('Missing required parameter: file');

      const targetPath = path.resolve(context.legacyPath, args.file);
      if (!targetPath.startsWith(path.resolve(context.legacyPath))) {
        throw new Error('Access denied: path is outside the workspace.');
      }
      if (!(await fs.pathExists(targetPath))) {
        return { error: `File does not exist: ${args.file}` };
      }
      const stats = await fs.stat(targetPath);
      if (stats.isDirectory()) {
        return { error: `${args.file} is a directory. Use getWorkspaceFileList to view its contents.` };
      }

      const content = await fs.readFile(targetPath, 'utf-8');

      // Support offset/limit chunking (same as snside FileContentFunction)
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split(/\r?\n/);
        const start = args.offset ?? 0;
        const end = args.limit !== undefined ? start + args.limit : lines.length;
        const sliced = lines.slice(start, end);
        const startLine = start + 1;
        const endLine = Math.min(end, lines.length);
        const header = `[Lines ${startLine}–${endLine} of ${lines.length} total. Use offset and limit to read other ranges.]`;
        return `${header}\n${sliced.join('\n')}`;
      }

      return content;
    }
  },

  // ── searchInWorkspace ─────────────────────────────────────────────────────
  // Mirrors: WorkspaceSearchProvider (browser/workspace-search-provider.ts)
  // ID:      SEARCH_IN_WORKSPACE_FUNCTION_ID = 'searchInWorkspace'
  [SEARCH_IN_WORKSPACE_FUNCTION_ID]: {
    name: 'searchInWorkspace',
    description:
      'Searches all text files in the legacy workspace for lines matching a specified text query. ' +
      'Returns matching lines with file path and line number. Maximum 100 results. ' +
      'Use this to find specific function definitions, class names, or patterns across all files. ' +
      'Do NOT use this for directory listing — use getWorkspaceFileList instead.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string (e.g. a function name, class name, or import pattern). Case-insensitive.'
        }
      },
      required: ['query']
    },
    handler: async (args: { query: string }, context) => {
      const basePath = context.legacyPath;
      const files = await glob('**/*', {
        cwd: basePath,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
                 '**/__pycache__/**', '**/vendor/**', '**/target/**', '**/.next/**'],
        dot: true
      });

      const results: { file: string; line: number; content: string }[] = [];
      const lowerQuery = args.query.toLowerCase();

      for (const file of files) {
        const filePath = path.join(basePath, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              results.push({ file, line: i + 1, content: lines[i].trim() });
              if (results.length >= 100) {
                return { results, limitReached: true, message: 'Result limit of 100 reached.' };
              }
            }
          }
        } catch {
          // Skip unreadable/binary files silently
        }
      }

      return { results, total: results.length };
    }
  },

  // ── findFilesByPattern ────────────────────────────────────────────────────
  // Mirrors: FindFilesByPattern (browser/workspace-functions.ts)
  // ID:      FIND_FILES_BY_PATTERN_FUNCTION_ID = 'findFilesByPattern'
  [FIND_FILES_BY_PATTERN_FUNCTION_ID]: {
    name: 'findFilesByPattern',
    description:
      'Finds files in the legacy workspace matching a given glob pattern. ' +
      'Use this to locate specific file types (e.g. "**/*.ts"), manifest files (e.g. "package.json"), ' +
      'or language-specific patterns (e.g. "**/*.py", "**/*.java", "CMakeLists.txt"). ' +
      'Use this BEFORE calling getFileContent to confirm the file exists and get its exact path.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js", "package.json", "**/*.py").'
        }
      },
      required: ['pattern']
    },
    handler: async (args: { pattern: string }, context) => {
      const basePath = context.legacyPath;
      const files = await glob(args.pattern, {
        cwd: basePath,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
                 '**/__pycache__/**', '**/vendor/**', '**/target/**', '**/.next/**'],
        dot: true
      });
      return { files, count: files.length };
    }
  },

  // ── getDependencyTree ─────────────────────────────────────────────────────
  // Mirrors: GetDependencyTree (browser/migration-dependency-tools.ts)
  // ID:      GET_DEPENDENCY_TREE_FUNCTION_ID = 'getDependencyTree'
  [GET_DEPENDENCY_TREE_FUNCTION_ID]: {
    name: 'getDependencyTree',
    description:
      'Reads and parses ALL dependency manifests in the legacy workspace ' +
      '(package.json, requirements.txt, pom.xml, go.mod, Cargo.toml, build.gradle, composer.json, Gemfile, *.csproj, pyproject.toml). ' +
      'Returns a structured JSON object with all dependency names and versions per manifest. ' +
      'Use this during Phase 1 Discovery to build the Dependency section in Stage1_Analysis.md. ' +
      'This is essential for identifying legacy libraries and their versions.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional relative directory path to search (default: workspace root). Use "." or "" for root.'
        }
      },
      required: []
    },
    handler: async (args: { path?: string }, context) => {
      const basePath = args.path
        ? path.resolve(context.legacyPath, args.path)
        : context.legacyPath;

      if (!basePath.startsWith(path.resolve(context.legacyPath))) {
        throw new Error('Access denied: path is outside the workspace.');
      }

      const manifests = [
        { file: 'package.json',      type: 'npm',     parser: parsePackageJson },
        { file: 'requirements.txt',  type: 'pip',     parser: parseRequirementsTxt },
        { file: 'Pipfile',           type: 'pip',     parser: parsePipfile },
        { file: 'pom.xml',           type: 'maven',   parser: parsePomXml },
        { file: 'build.gradle',      type: 'gradle',  parser: parseBuildGradle },
        { file: 'go.mod',            type: 'go',      parser: parseGoMod },
        { file: 'Cargo.toml',        type: 'cargo',   parser: parseCargoToml },
        { file: 'Gemfile',           type: 'ruby',    parser: parseGemfile },
        { file: 'composer.json',     type: 'php',     parser: parseComposerJson },
        { file: 'pyproject.toml',    type: 'pip',     parser: parsePyprojectToml },
      ];

      // Also recursively find all package.json files in subdirectories (monorepo support)
      const extraPackageJsonFiles = await glob('**/package.json', {
        cwd: basePath,
        onlyFiles: true,
        ignore: ['**/node_modules/**'],
        dot: false
      });

      const results: any[] = [];

      // Check root-level manifests
      for (const m of manifests) {
        const filePath = path.join(basePath, m.file);
        try {
          if (await fs.pathExists(filePath)) {
            const content = await fs.readFile(filePath, 'utf-8');
            results.push({ type: m.type, file: m.file, ...m.parser(content) });
          }
        } catch { /* skip unreadable */ }
      }

      // Check extra package.json in subdirs (monorepo packages)
      for (const relPath of extraPackageJsonFiles) {
        if (relPath === 'package.json') continue; // already handled above
        try {
          const content = await fs.readFile(path.join(basePath, relPath), 'utf-8');
          results.push({ type: 'npm', file: relPath, ...parsePackageJson(content) });
        } catch { /* skip */ }
      }

      if (results.length === 0) {
        return {
          warning: 'No dependency manifests found. This may be a C++ or low-level project without a package manager.',
          searched: manifests.map(m => m.file)
        };
      }

      return { manifests: results, totalManifests: results.length };
    }
  },

  // ── batch-read-files ─────────────────────────────────────────────────────
  // Mirrors: BatchFileReader (browser/migration-batch-reader-tool.ts)
  // ID:      BATCH_READ_FILES_FUNCTION_ID = 'batch-read-files'
  [BATCH_READ_FILES_FUNCTION_ID]: {
    name: 'batch-read-files',
    description:
      'Reads up to 10 workspace files in parallel and returns their content in a single call. ' +
      'Use this in Phase 1 (FileAnalyzer) instead of individual getFileContent calls when processing batches. ' +
      'Each entry specifies: path (relative to workspace root), optional offset (start line, 1-based), optional limit (max lines to return). ' +
      'Returns an array with one result per file: { path, content, lineCount, sizeBytes, language, error? }. ' +
      'Max 10 files per call. Max 300KB total payload. ' +
      'Files exceeding the payload limit are returned with an error field and empty content.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Array of file read requests. Max 10 entries.',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File path relative to workspace root.'
              },
              offset: {
                type: 'number',
                description: 'Optional. Start line (1-based). Default: 1 (start of file).'
              },
              limit: {
                type: 'number',
                description: 'Optional. Max lines to return. Default: full file.'
              }
            },
            required: ['path']
          }
        }
      },
      required: ['files']
    },
    handler: async (args: { files: Array<{ path: string; offset?: number; limit?: number }> }, context) => {
      const entries = args.files ?? [];
      if (!Array.isArray(entries) || entries.length === 0) {
        return { error: 'files array is required and must not be empty' };
      }
      if (entries.length > 10) {
        return { error: 'Max 10 files per batch call. Split into multiple batches.' };
      }

      const MAX_TOTAL_BYTES = 300 * 1024; // 300KB
      let totalBytes = 0;

      const results = await Promise.all(entries.map(async (entry) => {
        const relPath = entry.path;
        const targetPath = path.resolve(context.legacyPath, relPath);
        if (!targetPath.startsWith(path.resolve(context.legacyPath))) {
          return { path: relPath, error: 'Path traversal denied — file is outside workspace' };
        }
        try {
          if (!(await fs.pathExists(targetPath))) {
            return { path: relPath, error: 'File does not exist.' };
          }
          const stat = await fs.stat(targetPath);
          if (stat.isDirectory()) {
            return { path: relPath, error: 'Path is a directory, not a file.' };
          }

          const rawContent = await fs.readFile(targetPath, 'utf-8');
          const allLines = rawContent.split(/\r?\n/);
          const lineCount = allLines.length;

          const offset = Math.max(0, (entry.offset ?? 1) - 1);
          const slicedLines = entry.limit
            ? allLines.slice(offset, offset + entry.limit)
            : allLines.slice(offset);
          const content = slicedLines.join('\n');
          const contentBytes = Buffer.byteLength(content, 'utf8');

          totalBytes += contentBytes;
          if (totalBytes > MAX_TOTAL_BYTES) {
            return {
              path: relPath,
              error: 'Skipped — total batch payload exceeds 300KB limit. Read this file separately.',
              lineCount,
              sizeBytes: stat.size
            };
          }

          const ext = path.extname(relPath).toLowerCase();
          const langMap: Record<string, string> = {
            '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
            '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust', '.php': 'php',
            '.rb': 'ruby', '.cs': 'csharp', '.kt': 'kotlin', '.swift': 'swift',
            '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown',
            '.html': 'html', '.css': 'css', '.scss': 'scss', '.sql': 'sql'
          };
          const language = langMap[ext] ?? 'plaintext';

          return {
            path: relPath,
            content,
            lineCount,
            sizeBytes: stat.size,
            language
          };
        } catch (err: any) {
          return { path: relPath, error: err.message };
        }
      }));

      return results;
    }
  },

  // ── write_file ────────────────────────────────────────────────────────────
  // Writes output files (Stage1_Analysis.md, migration-plan.md) to modernPath.
  write_file: {
    name: 'write_file',
    description:
      'Writes content to a file in the output workspace (modernPath). ' +
      'Use this to write Stage1_Analysis.md, migration-plan.md, or any analysis report. ' +
      'Always writes to the modern output directory — never modifies the legacy source files.',
    parameters: {
      type: 'object',
      properties: {
        relativePath: {
          type: 'string',
          description: 'The relative destination file path inside the output directory (e.g. "Stage1_Analysis.md").'
        },
        path: {
          type: 'string',
          description: 'Alias for relativePath.'
        },
        file_path: {
          type: 'string',
          description: 'Alias for relativePath.'
        },
        content: {
          type: 'string',
          description: 'The complete string content to write to the file.'
        }
      },
      required: ['content']
    },
    handler: async (args: { relativePath?: string; path?: string; file_path?: string; content: string }, context) => {
      const resolvedPath = args.relativePath || args.path || args.file_path;
      if (!resolvedPath) {
        throw new Error('Missing destination path. Provide relativePath, path, or file_path.');
      }
      await writeSessionFile(context.modernPath, resolvedPath, args.content);
      return { success: true, path: resolvedPath, message: `File written successfully to ${resolvedPath}` };
    }
  },

  // ── get_task_context ──────────────────────────────────────────────────────
  // Persistent memory — read the session task context JSON.
  get_task_context: {
    name: 'get_task_context',
    description:
      'Retrieves the complete persistent JSON task context dictionary for the current session. ' +
      'Contains phase indicators (ACTIVE_PHASE), checkpoints (LAST_FILE_ANALYZED, FILE_INDEX_KEY), ' +
      'named keys (file-index, rules-by-file, lang-profiles, dep-matrix), and any saved progress flags. ' +
      'Call this at the start of every session to check where analysis left off.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => {
      return await TaskContextManager.getContext(context.sessionId);
    }
  },

  // ── edit_task_context ─────────────────────────────────────────────────────
  // Persistent memory — update/merge into the session task context JSON.
  edit_task_context: {
    name: 'edit_task_context',
    description:
      'Updates or merges specific key-value pairs into the persistent session task context dictionary. ' +
      'Use this to save: ACTIVE_PHASE, LAST_FILE_ANALYZED, FILE_INDEX_KEY, file-index (full array), ' +
      'rules-by-file (per-file map), lang-profiles, dep-matrix, and any checkpoint/progress flags. ' +
      'Always save large objects (file indexes, rule maps) under NAMED KEYS (e.g. key="file-index") not inline.',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'object',
          description: 'A key-value dictionary of fields to save/update (e.g. { "ACTIVE_PHASE": "2", "file-index": [...] }).'
        }
      },
      required: ['updates']
    },
    handler: async (args: { updates: Record<string, any> }, context) => {
      await TaskContextManager.updateContext(context.sessionId, args.updates);
      return { success: true, keysUpdated: Object.keys(args.updates) };
    }
  },

  // ── run_command ───────────────────────────────────────────────────────────
  // Safely runs shell commands inside the modernPath (output) directory.
  run_command: {
    name: 'run_command',
    description: 'Safely runs a command (like build, lint, or test) inside the target modernized project path.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact CLI command string to execute.'
        }
      },
      required: ['command']
    },
    handler: async (args: { command: string }, context) => {
      const result = await ShellExecutor.execute(context.sessionId, args.command, {
        cwd: context.modernPath,
        onLog: (msg, isErr) => {
          if (context.onLog) context.onLog(msg, isErr ? 'error' : 'info');
        },
        timeoutMs: 60000
      });
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  },

  // ── list_directory ────────────────────────────────────────────────────────
  // Legacy tool kept for backward compatibility — delegates to getWorkspaceFileList.
  list_directory: {
    name: 'list_directory',
    description:
      'Lists all files and directories within a subdirectory of the legacy (source) or modern (target) project. ' +
      'Prefer getWorkspaceFileList for the legacy directory during Stage 1 analysis.',
    parameters: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          enum: ['legacy', 'modern'],
          description: 'Which workspace directory to use as the base path.'
        },
        relativePath: {
          type: 'string',
          description: 'The relative path from the base directory. Defaults to root.'
        }
      },
      required: ['base']
    },
    handler: async (args: { base: 'legacy' | 'modern'; relativePath?: string }, context) => {
      const basePath = args.base === 'legacy' ? context.legacyPath : context.modernPath;
      const targetPath = path.resolve(basePath, args.relativePath || '');
      if (!targetPath.startsWith(path.resolve(basePath))) {
        throw new Error('Access denied: path is outside the workspace.');
      }
      if (!(await fs.pathExists(targetPath))) {
        return { error: `Directory does not exist: ${args.relativePath || '/'}` };
      }
      const items = await fs.readdir(targetPath, { withFileTypes: true });
      return items.map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : 'file' }));
    }
  },

  // ── read_file ─────────────────────────────────────────────────────────────
  // Legacy tool kept for backward compatibility — delegates to getFileContent.
  read_file: {
    name: 'read_file',
    description: 'Reads the content of a file from the legacy or modern project path. Prefer getFileContent during Stage 1.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', enum: ['legacy', 'modern'], description: 'Which workspace directory.' },
        relativePath: { type: 'string', description: 'Relative path from base.' },
        path: { type: 'string', description: 'Alias for relativePath.' },
        file_path: { type: 'string', description: 'Alias for relativePath.' }
      },
      required: ['base']
    },
    handler: async (args: { base: 'legacy' | 'modern'; relativePath?: string; path?: string; file_path?: string }, context) => {
      const resolvedPath = args.relativePath || args.path || args.file_path;
      if (!resolvedPath) throw new Error('Missing file path.');
      const basePath = args.base === 'legacy' ? context.legacyPath : context.modernPath;
      const targetPath = path.resolve(basePath, resolvedPath);
      if (!targetPath.startsWith(path.resolve(basePath))) {
        throw new Error('Access denied.');
      }
      if (!(await fs.pathExists(targetPath))) return { error: `File does not exist: ${resolvedPath}` };
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) return { error: `${resolvedPath} is a directory.` };
      const content = await fs.readFile(targetPath, 'utf-8');
      return { content };
    }
  },

  // ── search_code ───────────────────────────────────────────────────────────
  // Legacy tool kept for backward compat — same as searchInWorkspace but with base selector.
  search_code: {
    name: 'search_code',
    description: 'Searches all text files in the legacy or modern project for lines matching a query. Prefer searchInWorkspace.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', enum: ['legacy', 'modern'] },
        query: { type: 'string', description: 'Search query.' }
      },
      required: ['base', 'query']
    },
    handler: async (args: { base: 'legacy' | 'modern'; query: string }, context) => {
      const basePath = args.base === 'legacy' ? context.legacyPath : context.modernPath;
      const files = await glob('**/*', {
        cwd: basePath, onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'], dot: true
      });
      const results: any[] = [];
      const lowerQuery = args.query.toLowerCase();
      for (const file of files) {
        try {
          const content = await fs.readFile(path.join(basePath, file), 'utf-8');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              results.push({ file, line: i + 1, content: lines[i].trim() });
              if (results.length >= 100) return { results, limitReached: true };
            }
          }
        } catch {}
      }
      return { results };
    }
  },

  // ── getFileDiagnostics ────────────────────────────────────────────────────
  // Mirrors: FileDiagnosticProvider (browser/workspace-functions.ts)
  // Returns empty array in BE context (no LSP available) — kept for prompt compatibility.
  [GET_FILE_DIAGNOSTICS_ID]: {
    name: 'getFileDiagnostics',
    description: 'Retrieves diagnostic warnings and errors for a specific file. Note: in backend mode this returns an empty list as no LSP is available.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative path of the file to check.' }
      },
      required: ['file']
    },
    handler: async (_args, _context) => {
      return { diagnostics: [], note: 'No LSP diagnostics available in backend mode.' };
    }
  },

};

// ─────────────────────────────────────────────────────────────────────────────
//  MANIFEST PARSERS — used by getDependencyTree
// ─────────────────────────────────────────────────────────────────────────────

function parsePackageJson(content: string) {
  try {
    const pkg = JSON.parse(content);
    return {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      scripts: pkg.scripts || {}
    };
  } catch {
    return { dependencies: {}, devDependencies: {} };
  }
}

function parseRequirementsTxt(content: string) {
  const deps: Record<string, string> = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) return;
    const match = trimmed.match(/^([a-zA-Z0-9_\-\[\]]+)([><=!~^]+.+)?$/);
    if (match) deps[match[1]] = match[2]?.trim() || '*';
  });
  return { dependencies: deps };
}

function parsePipfile(content: string) {
  const deps: Record<string, string> = {};
  let inPackages = false;
  content.split('\n').forEach(line => {
    if (line.trim() === '[packages]') { inPackages = true; return; }
    if (line.startsWith('[') && line.trim() !== '[packages]') { inPackages = false; }
    if (inPackages) {
      const match = line.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"?(.+?)"?$/);
      if (match) deps[match[1]] = match[2];
    }
  });
  return { dependencies: deps };
}

function parsePomXml(content: string) {
  const deps: Record<string, string> = {};
  const depRegex = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
  let match;
  while ((match = depRegex.exec(content)) !== null) {
    deps[`${match[1]}:${match[2]}`] = match[3] || '*';
  }
  return { dependencies: deps };
}

function parseBuildGradle(content: string) {
  const deps: Record<string, string> = {};
  const depRegex = /(?:implementation|compile|api|testImplementation)\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = depRegex.exec(content)) !== null) {
    deps[match[1]] = '*';
  }
  return { dependencies: deps };
}

function parseGoMod(content: string) {
  const deps: Record<string, string> = {};
  const lines = content.split('\n');
  let inRequire = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'require (') { inRequire = true; continue; }
    if (trimmed === ')' && inRequire) { inRequire = false; continue; }
    if (inRequire || trimmed.startsWith('require ')) {
      const match = trimmed.replace('require ', '').trim().match(/^(\S+)\s+(\S+)/);
      if (match) deps[match[1]] = match[2];
    }
  }
  return { dependencies: deps };
}

function parseCargoToml(content: string) {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {};
  let section = '';
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed === '[dependencies]') { section = 'deps'; return; }
    if (trimmed === '[dev-dependencies]') { section = 'dev'; return; }
    if (trimmed.startsWith('[')) { section = ''; return; }
    const match = trimmed.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"?([^"]+)"?/);
    if (match) {
      if (section === 'deps') deps[match[1]] = match[2];
      else if (section === 'dev') devDeps[match[1]] = match[2];
    }
  });
  return { dependencies: deps, devDependencies: devDeps };
}

function parseGemfile(content: string) {
  const deps: Record<string, string> = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) return;
    const match = trimmed.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (match) deps[match[1]] = match[2] || '*';
  });
  return { dependencies: deps };
}

function parseComposerJson(content: string) {
  try {
    const composer = JSON.parse(content);
    const deps: Record<string, string> = {};
    const devDeps: Record<string, string> = {};
    for (const [pkg, ver] of Object.entries(composer.require || {})) {
      if (pkg !== 'php' && !pkg.startsWith('ext-')) deps[pkg] = String(ver);
    }
    for (const [pkg, ver] of Object.entries(composer['require-dev'] || {})) {
      devDeps[pkg] = String(ver);
    }
    return { dependencies: deps, devDependencies: devDeps, scripts: composer.scripts || {} };
  } catch {
    return { dependencies: {} };
  }
}

function parsePyprojectToml(content: string) {
  const deps: Record<string, string> = {};
  let inPoetryDeps = false;
  content.split('\n').forEach(line => {
    if (line.trim() === '[tool.poetry.dependencies]') { inPoetryDeps = true; return; }
    if (line.startsWith('[') && inPoetryDeps) { inPoetryDeps = false; return; }
    if (inPoetryDeps) {
      const match = line.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"?([^"]+)"?/);
      if (match && match[1] !== 'python') deps[match[1]] = match[2];
    }
  });
  return { dependencies: deps };
}
