import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { writeSessionFile } from './fileWriter.js';
import { ShellExecutor } from './shellExecutor.js';
import { TaskContextManager } from '../session/taskContext.js';
import { SessionManager } from '../session/sessionManager.js';
import { EventBroadcaster } from '../routes/stream.js';
import { writeJsonAtomic, readJsonWithRetry } from '../session/fileUtils.js';
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
import { mergeGraphData, getValidGraphNames } from './knowledge/knowledge-graph-utils.js';

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

  // ── extractFileSymbols ───────────────────────────────────────────────────
  // Mirrors: ExtractFileSymbols (browser/migration-large-file-tools.ts)
  // Extracts function/class symbols from a source file + recommends reading strategy.
  extractFileSymbols: {
    name: 'extractFileSymbols',
    description:
      'Extracts the symbol map (functions, classes, methods) from a source file and returns '
      + 'the recommended reading strategy based on file size. '
      + 'readingStrategy: SMALL (≤200 lines) = read whole file; MEDIUM (201-500) = symbol-targeted reads; '
      + 'LARGE (501-2500) = chunked reads with checkpoints; ULTRA_LARGE (2500+) = multi-pass streaming. '
      + 'ALWAYS call this before getFileContent on any source file.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative path to the source file within the legacy workspace.' }
      },
      required: ['file']
    },
    handler: async (args: { file: string }, context: ToolContext) => {
      const targetPath = path.resolve(context.legacyPath, args.file);
      if (!targetPath.startsWith(path.resolve(context.legacyPath))) throw new Error('Access denied.');
      if (!(await fs.pathExists(targetPath))) return { error: `File not found: ${args.file}` };
      const stat = await fs.stat(targetPath);
      if (stat.isDirectory()) return { error: 'Path is a directory.' };

      const content = await fs.readFile(targetPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const lineCount = lines.length;

      // Determine reading strategy
      const readingStrategy =
        lineCount <= 200 ? 'SMALL' :
        lineCount <= 500 ? 'MEDIUM' :
        lineCount <= 2500 ? 'LARGE' : 'ULTRA_LARGE';

      // Regex-based symbol extraction (supports JS/TS/Python/Java/Go/PHP/Ruby/C++/C#)
      const symbols: any[] = [];
      const patterns = [
        // JavaScript/TypeScript functions & classes
        { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm,    type: 'function' },
        { regex: /^\s*(?:export\s+)?class\s+(\w+)/gm,                          type: 'class' },
        { regex: /^\s*(?:public|private|protected|static|async)?\s+(\w+)\s*\([^)]*\)\s*[:{]/gm, type: 'method' },
        { regex: /^\s*const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/gm, type: 'arrow_fn' },
        // Python
        { regex: /^def\s+(\w+)\s*\(/gm,      type: 'function' },
        { regex: /^class\s+(\w+)/gm,          type: 'class' },
        // Java/C#
        { regex: /(?:public|private|protected|static)\s+\w+\s+(\w+)\s*\(/gm, type: 'method' },
        // Go
        { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm, type: 'function' },
        // PHP
        { regex: /^\s*(?:public|private|protected)?\s*function\s+(\w+)\s*\(/gm, type: 'function' },
        // Ruby
        { regex: /^\s*def\s+(\w+)/gm, type: 'function' },
      ];

      const seen = new Set<string>();
      for (const { regex, type } of patterns) {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(content)) !== null) {
          const name = match[1];
          if (!name || seen.has(name)) continue;
          seen.add(name);
          // Find line number
          const before = content.slice(0, match.index);
          const startLine = before.split('\n').length;
          symbols.push({ name, type, startLine, endLine: startLine + 5 });
        }
      }

      return {
        file: args.file,
        lineCount,
        readingStrategy,
        symbolCount: symbols.length,
        symbols: symbols.slice(0, 200), // cap at 200 to avoid context overflow
        recommendation: readingStrategy === 'SMALL'
          ? 'Read entire file with getFileContent (no offset/limit needed).'
          : readingStrategy === 'MEDIUM'
          ? 'Use getFileContent with offset/limit per symbol (startLine-1, lineCount).'
          : readingStrategy === 'LARGE'
          ? 'Read 10 symbols per turn using getFileContent with offset/limit. Save CHUNK_PROGRESS checkpoints.'
          : 'MANDATORY MULTI-PASS: 5 symbols per turn max. Save per-symbol analysis notes after each batch.'
      };
    }
  },

  // ── getEnvironmentInfo ───────────────────────────────────────────────────
  // Mirrors: GetEnvironmentInfo (browser/migration-env-tools.ts)
  getEnvironmentInfo: {
    name: 'getEnvironmentInfo',
    description:
      'Detects runtime versions (Node.js, Python, Java, Go, Rust, PHP, Ruby), package managers, '
      + 'and system environment info. Call once at the start of Phase 1 environment probe.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args: {}, context: ToolContext) => {
      const results: Record<string, string> = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      };

      const cmds: [string, string][] = [
        ['pythonVersion',  'python --version'],
        ['python3Version', 'python3 --version'],
        ['javaVersion',    'java -version'],
        ['goVersion',      'go version'],
        ['rustVersion',    'rustc --version'],
        ['phpVersion',     'php --version'],
        ['rubyVersion',    'ruby --version'],
        ['gitVersion',     'git --version'],
        ['dockerVersion',  'docker --version'],
        ['npmVersion',     'npm --version'],
        ['yarnVersion',    'yarn --version'],
        ['pnpmVersion',    'pnpm --version'],
        ['dotnetVersion',  'dotnet --version'],
      ];

      for (const [key, cmd] of cmds) {
        try {
          const res = await ShellExecutor.execute(context.sessionId, cmd, {
            cwd: context.legacyPath,
            timeoutMs: 5000,
          });
          if (res.code === 0) {
            results[key] = (res.stdout || res.stderr || '').trim().split('\n')[0];
          } else {
            results[key] = 'not installed';
          }
        } catch {
          results[key] = 'not installed';
        }
      }

      return results;
    }
  },

  // ── getGitLog ────────────────────────────────────────────────────────────
  // Mirrors: GetGitLog (browser/migration-git-tools.ts)
  getGitLog: {
    name: 'getGitLog',
    description:
      'Retrieves git commit history from the legacy workspace. '
      + 'Returns recent commits, high-churn files (most commits), and dead code candidates (no commits in past year). '
      + 'Use during Phase 1 environment probe to identify migration risk areas.',
    parameters: {
      type: 'object',
      properties: {
        maxCommits: { type: 'number', description: 'Maximum commits to retrieve (default: 200).' }
      },
      required: []
    },
    handler: async (args: { maxCommits?: number }, context: ToolContext) => {
      const max = args.maxCommits ?? 200;
      try {
        const res = await ShellExecutor.execute(
          context.sessionId,
          `git log --name-only --format="COMMIT:%H|%ai|%s" -n ${max}`,
          { cwd: context.legacyPath, timeoutMs: 15000 }
        );

        if (res.code !== 0) {
          return { error: 'Git log failed. Not a git repo or git not installed.', stderr: res.stderr };
        }

        const lines = res.stdout.split('\n');
        const commits: { hash: string; date: string; message: string; files: string[] }[] = [];
        const fileCounts: Record<string, number> = {};
        let currentCommit: typeof commits[0] | null = null;
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const recentFiles = new Set<string>();

        for (const line of lines) {
          if (line.startsWith('COMMIT:')) {
            if (currentCommit) commits.push(currentCommit);
            const [_, hash, date, ...msgParts] = line.split('|');
            currentCommit = { hash: hash?.replace('COMMIT:', ''), date, message: msgParts.join('|'), files: [] };
            if (currentCommit.date && new Date(currentCommit.date) > oneYearAgo) {
              // file is recently touched — will be added below
            }
          } else if (line.trim() && currentCommit && !line.startsWith('COMMIT:')) {
            currentCommit.files.push(line.trim());
            fileCounts[line.trim()] = (fileCounts[line.trim()] || 0) + 1;
            if (currentCommit.date && new Date(currentCommit.date) > oneYearAgo) {
              recentFiles.add(line.trim());
            }
          }
        }
        if (currentCommit) commits.push(currentCommit);

        const sortedByChurn = Object.entries(fileCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([file, count]) => ({ file, commits: count }));

        const allFiles = Object.keys(fileCounts);
        const deadCodeCandidates = allFiles.filter(f => !recentFiles.has(f)).slice(0, 20);

        return {
          totalCommits: commits.length,
          commits: commits.slice(0, 20), // Only return first 20 to avoid context overflow
          highChurnFiles: sortedByChurn,
          deadCodeCandidates,
          note: `Full history: ${commits.length} commits analyzed.`
        };
      } catch (err: any) {
        return { error: err.message };
      }
    }
  },

  // ── scanAssetFiles ───────────────────────────────────────────────────────
  // Mirrors: ScanAssetFiles (browser/migration-asset-tools.ts)
  scanAssetFiles: {
    name: 'scanAssetFiles',
    description:
      'Scans the legacy workspace for all non-code asset files: images, fonts, stylesheets, '
      + 'env files, Dockerfiles, SQL scripts, config files, etc. '
      + 'Call during Phase 1 as mandatory asset inventory before generating Stage1_Analysis.md.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args: {}, context: ToolContext) => {
      const base = context.legacyPath;
      const ignorePatterns = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/__pycache__/**'];

      const scan = async (patterns: string[]) =>
        glob(patterns, { cwd: base, onlyFiles: true, ignore: ignorePatterns, dot: true });

      const [images, fonts, stylesheets, envFiles, dockerFiles, sqlFiles, configFiles] = await Promise.all([
        scan(['**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.svg', '**/*.ico', '**/*.webp']),
        scan(['**/*.ttf', '**/*.woff', '**/*.woff2', '**/*.eot', '**/*.otf']),
        scan(['**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.styl']),
        scan(['.env', '.env.*', '**/.env', '**/.env.*']),
        scan(['**/Dockerfile', '**/docker-compose*.yml', '**/docker-compose*.yaml']),
        scan(['**/*.sql', '**/migrations/**', '**/schema.sql', '**/seed.sql']),
        scan(['**/*.yaml', '**/*.yml', '**/*.toml', '**/*.ini', '**/*.conf', '**/config.*', '**/*.config.*']),
      ]);

      return {
        images: images.slice(0, 100),
        fonts,
        stylesheets,
        envFiles,
        dockerFiles,
        sqlFiles,
        configFiles: configFiles.slice(0, 50),
        totalAssets: images.length + fonts.length + stylesheets.length + envFiles.length + dockerFiles.length + sqlFiles.length + configFiles.length,
      };
    }
  },

  // ── copyStaticAssets ─────────────────────────────────────────────────────
  // Mirrors: CopyStaticAssets (browser/migration-asset-tools.ts)
  copyStaticAssets: {
    name: 'copyStaticAssets',
    description: 'Copies specified asset files from the legacy workspace to the same relative path in the modern output workspace.',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array of relative file paths to copy from legacy to modern.' }
      },
      required: ['files']
    },
    handler: async (args: { files: string[] }, context: ToolContext) => {
      const copied: string[] = [];
      const errors: string[] = [];
      for (const relPath of args.files) {
        try {
          const src = path.resolve(context.legacyPath, relPath);
          const dest = path.resolve(context.modernPath, relPath);
          if (!src.startsWith(path.resolve(context.legacyPath))) { errors.push(`Access denied: ${relPath}`); continue; }
          await fs.ensureDir(path.dirname(dest));
          await fs.copy(src, dest);
          copied.push(relPath);
        } catch (err: any) {
          errors.push(`${relPath}: ${err.message}`);
        }
      }
      return { copied, errors, totalCopied: copied.length };
    }
  },

  // ── capturedShellExecute ─────────────────────────────────────────────────
  // Mirrors: CapturedShellExecution (browser/migration-shell-capture-tool.ts)
  capturedShellExecute: {
    name: 'capturedShellExecute',
    description:
      'Runs a shell command and returns the FULL captured stdout + stderr output. '
      + 'Unlike run_command, this returns the complete output buffer (last 200 lines). '
      + 'Use for running build tools, package managers, test runners, and linters where full output is needed.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: {
          type: 'string',
          description: 'Working directory: "legacy" (source), "modern" (output), or an absolute path. Defaults to "modern".'
        },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 60000).' }
      },
      required: ['command']
    },
    handler: async (args: { command: string; cwd?: string; timeoutMs?: number }, context: ToolContext) => {
      const workingDir =
        args.cwd === 'legacy' ? context.legacyPath :
        args.cwd === 'modern' ? context.modernPath :
        (args.cwd && path.isAbsolute(args.cwd)) ? args.cwd :
        context.modernPath;

      const res = await ShellExecutor.execute(context.sessionId, args.command, {
        cwd: workingDir,
        timeoutMs: args.timeoutMs ?? 60000,
        onLog: (msg, isErr) => context.onLog?.(msg, isErr ? 'error' : 'info'),
      });

      const allOutput = [res.stdout, res.stderr].filter(Boolean).join('\n');
      const outputLines = allOutput.split('\n');
      const tails = outputLines.slice(-200).join('\n'); // Last 200 lines

      return {
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
        tails,
        timedOut: res.code === 124,
        command: args.command
      };
    }
  },

  // ── getSkillFileContent ──────────────────────────────────────────────────
  // Mirrors: GetSkillFileContent (browser/skill-file-functions.ts)
  getSkillFileContent: {
    name: 'getSkillFileContent',
    description: 'Reads a custom skill/rule template file from the skills directory. Skills are Markdown files with custom migration rules.',
    parameters: {
      type: 'object',
      properties: {
        skillPath: { type: 'string', description: 'Name or relative path of the skill file (e.g. "custom-rules.md").' }
      },
      required: ['skillPath']
    },
    handler: async (args: { skillPath: string }, context: ToolContext) => {
      try {
        // Look in a skills/ directory at the BE root (or session-specific)
        const skillsDir = path.join(process.cwd(), 'skills');
        const skillPath = path.resolve(skillsDir, args.skillPath);
        if (!skillPath.startsWith(skillsDir)) throw new Error('Access denied.');
        if (!(await fs.pathExists(skillPath))) {
          return { content: '', note: `Skill file "${args.skillPath}" not found. Using default behavior.` };
        }
        const content = await fs.readFile(skillPath, 'utf-8');
        return { content, skillPath: args.skillPath };
      } catch (err: any) {
        return { content: '', error: err.message };
      }
    }
  },

  // ── todoWrite ────────────────────────────────────────────────────────────
  // Mirrors: TodoWriteTool (browser/todo-tool.ts)
  todoWrite: {
    name: 'todoWrite',
    description:
      'Writes/updates a todo task list for progress tracking. Use this to mark files as analyzed or migrated. '
      + 'Each call broadcasts a todo_update SSE event so the terminal shows live progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Array of todo items.',
          items: {
            type: 'object',
            properties: {
              title:    { type: 'string', description: 'Task title, e.g. "Analyzed: src/auth.js".' },
              status:   { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status.' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Task priority.' }
            },
            required: ['title', 'status']
          }
        }
      },
      required: ['todos']
    },
    handler: async (args: { todos: Array<{ title: string; status: string; priority?: string }> }, context: ToolContext) => {
      // Save to task context under 'todo-list'
      await TaskContextManager.updateContext(context.sessionId, { 'todo-list': args.todos });

      // Broadcast to frontend
      EventBroadcaster.broadcast(context.sessionId, 'todo_update', {
        todos: args.todos,
        timestamp: new Date().toISOString()
      });

      // Also log summary to terminal
      const completed = args.todos.filter(t => t.status === 'completed').length;
      const total = args.todos.length;
      context.onLog?.(`[Todo] ${completed}/${total} tasks completed.`, 'info');

      return { saved: true, count: total, completed };
    }
  },

  // ── update-migration-dashboard ───────────────────────────────────────────
  // Mirrors: MigrationProgressDashboard (browser/migration-progress-dashboard-tool.ts)
  'update-migration-dashboard': {
    name: 'update-migration-dashboard',
    description:
      'Broadcasts a live progress update to the frontend dashboard. '
      + 'Call after every batch of files to update the progress bar and current file indicator. '
      + 'Also saves progress to session for reconnection hydration.',
    parameters: {
      type: 'object',
      properties: {
        filesCompleted: { type: 'number', description: 'Number of files analyzed/migrated so far.' },
        totalFiles:     { type: 'number', description: 'Total files in the index.' },
        currentFile:    { type: 'string', description: 'The file currently being processed.' },
        phase:          { type: 'string', description: 'Current phase name (e.g. "Phase 1: FileAnalyzer").' }
      },
      required: ['filesCompleted', 'totalFiles']
    },
    handler: async (args: { filesCompleted: number; totalFiles: number; currentFile?: string; phase?: string }, context: ToolContext) => {
      const percent = args.totalFiles > 0 ? Math.round((args.filesCompleted / args.totalFiles) * 100) : 0;

      EventBroadcaster.broadcast(context.sessionId, 'progress', {
        percent,
        filesCompleted: args.filesCompleted,
        totalFiles: args.totalFiles,
        currentFile: args.currentFile || '',
        phase: args.phase || 'Analysis',
      });

      context.onLog?.(`[Progress] ${args.filesCompleted}/${args.totalFiles} files (${percent}%)${args.currentFile ? ` — ${args.currentFile}` : ''}`, 'info');

      // Save to session
      await SessionManager.updateSession(context.sessionId, {
        completedFiles: args.filesCompleted,
        totalFiles: args.totalFiles,
        currentFile: args.currentFile,
      });

      return { broadcasted: true, percent };
    }
  },

  // ── compress-migration-context ───────────────────────────────────────────
  // Mirrors: SemanticContextCompressor (browser/migration-context-compressor-tool.ts)
  'compress-migration-context': {
    name: 'compress-migration-context',
    description:
      'Archives completed phase data to free up context window space. '
      + 'Moves large keys (file-index, rules-by-file, dep-matrix) to archive-* named keys, '
      + 'keeping only HOT keys (ACTIVE_PHASE, *_KEY pointers, TOTAL_FILES) inline. '
      + 'Call when CONTEXT_SIZE_WARNING=true is set in task context.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args: {}, context: ToolContext) => {
      const ctx = await TaskContextManager.getContext(context.sessionId);

      const ARCHIVE_KEYS = ['file-index', 'rules-by-file', 'lang-profiles', 'dep-matrix', 'symbols', 'analysis'];
      const archived: string[] = [];
      const archiveData: Record<string, any> = {};
      const keptKeys: string[] = [];

      for (const [key, value] of Object.entries(ctx)) {
        const shouldArchive = ARCHIVE_KEYS.some(ak => key === ak || key.startsWith(ak + ':'));
        if (shouldArchive && value !== undefined) {
          archiveData['archive-' + key] = value;
          archived.push(key);
        } else {
          keptKeys.push(key);
        }
      }

      // Remove archived keys and add archive pointers
      const updates: Record<string, any> = { ...archiveData, CONTEXT_COMPACTED: true, CONTEXT_SIZE_WARNING: false };
      for (const key of archived) updates[key] = undefined;

      await TaskContextManager.updateContext(context.sessionId, updates);
      context.onLog?.(`[Context] Archived ${archived.length} large keys. Kept ${keptKeys.length} HOT keys.`, 'info');

      return { archived, keptKeys, contextSizeReduced: archived.length > 0 };
    }
  },

  // ── write-migration-files ────────────────────────────────────────────────
  // Mirrors: MultiFileWriter (browser/migration-multi-writer-tool.ts)
  'write-migration-files': {
    name: 'write-migration-files',
    description:
      'Writes multiple files to the modern output workspace in a single call. '
      + 'More efficient than calling write_file individually. '
      + 'Broadcasts a file_migrated SSE event for each file written.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Array of files to write.',
          items: {
            type: 'object',
            properties: {
              path:    { type: 'string', description: 'Relative destination path in the output workspace.' },
              content: { type: 'string', description: 'File content to write.' }
            },
            required: ['path', 'content']
          }
        }
      },
      required: ['files']
    },
    handler: async (args: { files: Array<{ path: string; content: string }> }, context: ToolContext) => {
      const written: string[] = [];
      const errors: string[] = [];
      for (const file of args.files) {
        try {
          await writeSessionFile(context.modernPath, file.path, file.content);
          written.push(file.path);
          EventBroadcaster.broadcast(context.sessionId, 'file_migrated', { file: file.path });
          context.onLog?.(`Written: ${file.path}`, 'success');
        } catch (err: any) {
          errors.push(`${file.path}: ${err.message}`);
          context.onLog?.(`Failed to write ${file.path}: ${err.message}`, 'error');
        }
      }
      return { written, errors, totalWritten: written.length };
    }
  },

  // ── compareFiles ─────────────────────────────────────────────────────────
  // Mirrors: CompareFiles (browser/migration-compare-tools.ts)
  compareFiles: {
    name: 'compareFiles',
    description: 'Compares a legacy file with its modern equivalent and returns a unified diff. Use to verify migration fidelity.',
    parameters: {
      type: 'object',
      properties: {
        legacyFile: { type: 'string', description: 'Relative path to the legacy file.' },
        modernFile:  { type: 'string', description: 'Relative path to the modern file (in output workspace).' }
      },
      required: ['legacyFile', 'modernFile']
    },
    handler: async (args: { legacyFile: string; modernFile: string }, context: ToolContext) => {
      try {
        const legacyPath = path.resolve(context.legacyPath, args.legacyFile);
        const modernPath  = path.resolve(context.modernPath,  args.modernFile);
        if (!(await fs.pathExists(legacyPath))) return { error: `Legacy file not found: ${args.legacyFile}` };
        if (!(await fs.pathExists(modernPath)))  return { error: `Modern file not found: ${args.modernFile}` };

        const [legacyLines, modernLines] = await Promise.all([
          fs.readFile(legacyPath, 'utf-8').then(c => c.split('\n')),
          fs.readFile(modernPath,  'utf-8').then(c => c.split('\n')),
        ]);

        // Simple line-by-line diff
        let added = 0; let removed = 0;
        const diff: string[] = [];
        const maxLines = Math.max(legacyLines.length, modernLines.length);
        for (let i = 0; i < maxLines; i++) {
          const lLine = legacyLines[i] ?? '';
          const mLine = modernLines[i] ?? '';
          if (lLine !== mLine) {
            if (legacyLines[i] !== undefined) { diff.push(`- ${lLine}`); removed++; }
            if (modernLines[i] !== undefined) { diff.push(`+ ${mLine}`); added++; }
          }
        }

        const totalChanges = added + removed;
        const similarity = totalChanges === 0 ? 100
          : Math.round((1 - totalChanges / (maxLines * 2)) * 100);

        return {
          legacyFile: args.legacyFile,
          modernFile: args.modernFile,
          addedLines: added,
          removedLines: removed,
          similarity: `${similarity}%`,
          diff: diff.slice(0, 200).join('\n'), // Cap at 200 diff lines
        };
      } catch (err: any) {
        return { error: err.message };
      }
    }
  },

  // ── find-migration-session ───────────────────────────────────────────────
  // Mirrors: MigrationSessionFinder (browser/migration-session-finder-tool.ts)
  'find-migration-session': {
    name: 'find-migration-session',
    description: 'Scans all sessions to find incomplete migration sessions. Used for cross-session recovery on startup.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args: {}, context: ToolContext) => {
      try {
        const sessions = await SessionManager.listSessions();
        const incomplete = sessions
          .filter((s: any) => s.status !== 'complete' && s.status !== 'idle' && s.sessionId !== context.sessionId)
          .map((s: any) => ({
            sessionId: s.sessionId,
            status: s.status,
            phase: s.phases?.find((p: any) => p.status === 'active')?.label || 'Unknown',
            lastAction: s.currentFile || '',
            timestamp: s.startedAt || '',
          }));
        return { sessions: incomplete, found: incomplete.length };
      } catch {
        return { sessions: [], found: 0, note: 'Session listing not available.' };
      }
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

  // ── append-to-knowledge-graph ─────────────────────────────────────────────
  // Incrementally builds cross-file knowledge graphs during Phase 1 analysis.
  // Called after EVERY file read to contribute extracted data to the relevant graph(s).
  'append-to-knowledge-graph': {
    name: 'append-to-knowledge-graph',
    description:
      'Merges new analysis data into a named knowledge graph file stored in the output workspace '
      + '(_analysis/<graphName>-graph.json). Call this after EVERY file analysis to incrementally '
      + 'build cross-file knowledge graphs. Instead of loading 50+ raw per-file analysis keys at '
      + 'report time, the agent reads the pre-merged graphs. '
      + 'Valid graphName values: entity, symbol, rule, api, db, event, config, state, middleware, '
      + 'security, transform, error, async, test, integration, job, call-flow, architecture. '
      + 'Data is merged intelligently: entity/symbol/api/db/event graphs merge by key name; '
      + 'rule/transform/test graphs append arrays; security/architecture/middleware/error graphs deep-merge. '
      + 'MANDATORY after each file read — do NOT skip this step.',
    parameters: {
      type: 'object',
      properties: {
        graphName: {
          type: 'string',
          description:
            'Name of the knowledge graph to update. Must be one of: '
            + 'entity, symbol, rule, api, db, event, config, state, middleware, '
            + 'security, transform, error, async, test, integration, job, call-flow, architecture.'
        },
        data: {
          type: 'object',
          description:
            'Data to merge into the graph. Shape must match the graph schema. '
            + 'entity-graph: { "EntityName": { table, files:[...], fields:[...], relations:[...] } } '
            + 'symbol-graph: { "funcName": { file, signature, isAsync, calledBy:[...], calls:[...] } } '
            + 'rule-graph: { "domain": [{ rule, enforcement, violation, relatedFiles:[...] }] } '
            + 'api-graph: { "METHOD /path": { handler, auth, request:{}, responses:{}, middlewareChain:[...], files:[...] } } '
            + 'db-graph: { "tableName": { operations:[{ type, fields, condition, function, calledFrom:[...] }] } } '
            + 'event-graph: { "event.name": { emittedIn, payload, listeners:[{ file, handler, does }] } } '
            + 'config-graph: { "CONFIG_KEY": { type, required, default, purpose, usedIn:[...] } } '
            + 'state-graph: { "EntityName": { field, modelFile, states:[...], transitions:[...] } } '
            + 'middleware-graph: { globalPipeline:[{ order, name, file, purpose, appliesTo }], routeSpecific:{} } '
            + 'security-graph: { authMechanism, tokenStrategy:{}, roles:{}, publicRoutes:[...] } '
            + 'transform-graph: { "Name": { inputShape:{}, inputFile, transformFunction, outputShape:{}, outputFile } } '
            + 'error-graph: { customErrors:{ "ErrorName": { extends, status, definedIn, thrownIn:[...] } }, globalHandler:{} } '
            + 'async-graph: { "funcName": { pattern, awaits:[...], parallelOps:[...], fireAndForget:[...] } } '
            + 'test-graph: { framework, configFile, testFiles:{ "path": { covers, cases:[...], mocks:[...] } } } '
            + 'integration-graph: { "Provider": { purpose, auth, calledFrom, operations:[{ call, sends, receives }] } } '
            + 'job-graph: { "Job Name": { schedule, scheduledIn, implementation, calls, sideEffects:[...], type } } '
            + 'call-flow-graph: { "Use Case": { steps:[...] } } '
            + 'architecture-graph: { type, layers:[...], patterns:[...], modules:[...], entryPoint, communicationProtocol }'
        },
        sourceFile: {
          type: 'string',
          description: 'The file path that produced this data. Used for audit tracing. Optional but recommended.'
        }
      },
      required: ['graphName', 'data']
    },
    handler: async (args: { graphName: string; data: Record<string, any>; sourceFile?: string }, context) => {
      const validNames = getValidGraphNames();
      if (!validNames.includes(args.graphName)) {
        return {
          error: `Unknown graphName "${args.graphName}". Valid names: ${validNames.join(', ')}.`,
          validNames
        };
      }

      const analysisDir = path.join(context.modernPath, '_analysis');
      await fs.ensureDir(analysisDir);
      const graphPath = path.join(analysisDir, `${args.graphName}-graph.json`);

      // Load existing graph (or start with empty object)
      let existing: Record<string, any> = {};
      try {
        if (await fs.pathExists(graphPath)) {
          existing = await readJsonWithRetry<Record<string, any>>(graphPath);
        }
      } catch {
        existing = {}; // If file is corrupt, start fresh
      }

      // Merge incoming data using the correct strategy for this graph type
      const merged = mergeGraphData(args.graphName, existing, args.data);

      // Write merged result back
      await writeJsonAtomic(graphPath, merged);

      const entryCount = Object.keys(merged).length;
      const message = `Graph "${args.graphName}" updated: ${entryCount} top-level entries.`
        + (args.sourceFile ? ` (source: ${args.sourceFile})` : '');

      context.onLog?.(`[KnowledgeGraph] ${message}`, 'info');

      return {
        success: true,
        graphName: args.graphName,
        graphPath: `_analysis/${args.graphName}-graph.json`,
        entryCount,
        message
      };
    }
  },

  // ── read-knowledge-graph ──────────────────────────────────────────────────
  // Reads a fully-merged knowledge graph at report-writing time.
  // Agent calls this instead of loading 50+ raw per-file analysis keys.
  'read-knowledge-graph': {
    name: 'read-knowledge-graph',
    description:
      'Reads the current state of a named knowledge graph file from the output workspace. '
      + 'Use this at REPORT WRITING TIME (Phase 1_5) instead of loading raw per-file analysis '
      + 'keys from task context. Each section has a designated source graph — read that graph '
      + 'and write the section directly from the pre-merged, cross-referenced data. '
      + 'Section → Graph mapping: '
      + '5(Domain Models)→entity | 7(Functions)→symbol | 8(Behaviors)→symbol | 9(Business Rules)→rule | '
      + '10(API Contracts)→api | 11(Security)→security | 12(Middleware)→middleware | 13(DB Ops)→db | '
      + '14(Call Flows)→call-flow | 15(Transforms)→transform | 16(Config)→config | 17(Errors)→error | '
      + '18(Validation)→rule | 19(State)→state | 20(Async)→async | 21(Tests)→test | '
      + '22(Transactions)→db | 23(Events)→event | 24(Integrations)→integration | 25(Jobs)→job | '
      + '2(Architecture)→architecture.',
    parameters: {
      type: 'object',
      properties: {
        graphName: {
          type: 'string',
          description:
            'Name of the graph to read. One of: '
            + 'entity, symbol, rule, api, db, event, config, state, middleware, '
            + 'security, transform, error, async, test, integration, job, call-flow, architecture.'
        }
      },
      required: ['graphName']
    },
    handler: async (args: { graphName: string }, context) => {
      const validNames = getValidGraphNames();
      if (!validNames.includes(args.graphName)) {
        return {
          error: `Unknown graphName "${args.graphName}". Valid names: ${validNames.join(', ')}.`,
          validNames
        };
      }

      const graphPath = path.join(context.modernPath, '_analysis', `${args.graphName}-graph.json`);

      if (!(await fs.pathExists(graphPath))) {
        return {
          exists: false,
          graphName: args.graphName,
          data: {},
          entryCount: 0,
          message: `Graph not yet built: _analysis/${args.graphName}-graph.json. ` +
            `Run Phase 1 analysis first so append-to-knowledge-graph can populate this graph.`
        };
      }

      let data: Record<string, any> = {};
      try {
        data = await readJsonWithRetry<Record<string, any>>(graphPath);
      } catch (err: any) {
        return {
          exists: true,
          graphName: args.graphName,
          data: {},
          entryCount: 0,
          error: `Failed to read graph file: ${err.message}`
        };
      }

      const entryCount = Object.keys(data).length;
      const graphSizeBytes = JSON.stringify(data).length;

      context.onLog?.(`[KnowledgeGraph] Read "${args.graphName}-graph": ${entryCount} entries, ${Math.round(graphSizeBytes / 1024)}KB`, 'info');

      return {
        exists: true,
        graphName: args.graphName,
        graphPath: `_analysis/${args.graphName}-graph.json`,
        data,
        entryCount,
        graphSizeBytes,
        message: `Loaded ${args.graphName}-graph: ${entryCount} top-level entries.`
      };
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
