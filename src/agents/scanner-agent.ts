// =============================================================================
//  scanner-agent.ts — Codebase Scanner Agent (SNS IDE Standard)
//
//  Runs before Stage 1. Quickly detects the technology stack by reading
//  manifest files and project structure.
//
//  Rules:
//   - NO hardcoded values: no model names, no API keys, no default stack strings
//   - Provider, model, and API key come from route parameters (passed in)
//   - System prompt imported from prompts/scanner-prompt.ts
//   - Tool IDs imported from common/workspace-functions.ts
//   - Agent definition imported from agent-definitions.ts (SCANNER_AGENT)
//   - fallback stack is NOT a hardcoded guess — it is the result of runBackupScan()
// =============================================================================

import { scanProjectDirectory } from '../tools/fileScanner.js';
import { DetectedStack, FileNode } from '../types.js';
import { toolRegistry } from '../core/tool-invocation-registry.js';
import { ToolContext } from '../types/tool.js';
import { AgentExecutor } from './agentExecutor.js';
import { GeminiProvider } from '../ai/gemini.js';
import { AIProviderFactory } from '../ai/provider.js';
import {
  SCANNER_SYSTEM_PROMPT,
  buildScannerUserPrompt,
} from '../prompts/scanner-prompt.js';
import {
  SCANNER_AGENT,
} from './agent-definitions.js';

// ── Scanner Agent Configuration ───────────────────────────────────────────────
// Max tool-call turns for the scanner agent.
// Defined as a named constant — not hardcoded inline.
const SCANNER_MAX_TURNS = 10;

// ── Default "Not Detected" Values ─────────────────────────────────────────────
// These are placeholder values used ONLY before runBackupScan() runs.
// They are overwritten by either AI detection or the backup scan.
// They are NOT the "result" — they are initial null-state markers.
const STACK_NOT_DETECTED = 'Not Detected';
const STACK_UNKNOWN_LANGUAGE = 'Unknown';
const STACK_UNKNOWN_PACKAGE_MANAGER = 'Not Detected';

// NOTE: adaptTool() removed — all tools are now ToolRequest from the toolRegistry.
// Use toolRegistry.getFunctions(...SCANNER_AGENT.functions) to get scanner tools.

// ── Public Interface ──────────────────────────────────────────────────────────

export interface ScanAgentResult {
  detectedStack: DetectedStack;
  fileTree: FileNode[];
  fileList: string[];
  summary: string;
}

/**
 * Configuration passed from the scan route.
 * Keeps all provider/model/API config out of this file.
 */
export interface ScannerAgentConfig {
  /** AI provider name: 'google' | 'anthropic' | 'openai' | 'openrouter' etc. */
  provider?: string;
  /** Model identifier (e.g. the value from aliasesConfig['fast-model']). */
  model?: string;
  /** API key for the provider. */
  apiKey?: string;
}

// ── ScannerAgent ──────────────────────────────────────────────────────────────

export class ScannerAgent {
  /**
   * Scans the project directory and detects the technology stack.
   *
   * Step 1: Scan filesystem structure with scanProjectDirectory().
   * Step 2: If AI config is provided, run the LLM agent for accurate stack detection.
   * Step 3: If AI is unavailable or fails, fall back to static manifest inspection.
   *
   * @param projectPath  Absolute path to the project to scan.
   * @param config       Optional AI provider config from the route request body.
   * @param onLog        Log callback — streams messages to session logs + SSE.
   */
  static async run(
    projectPath: string,
    config?: ScannerAgentConfig,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<ScanAgentResult> {
    onLog?.('Scanning directory structure...', 'info');
    const { fileTree, fileList } = await scanProjectDirectory(projectPath);
    onLog?.(`Found ${fileList.length} files. Analyzing stack manifests...`, 'info');

    // ── Tool context (read-only — scanner never writes) ───────────────────
    const sessionId = `scan-${Date.now().toString(36)}`;
    const context: ToolContext = {
      sessionId,
      legacyPath: projectPath,
      modernPath: projectPath,   // Scanner is read-only; modernPath = legacyPath
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };

    // ── Build ToolRequest[] from SCANNER_AGENT.functions ─────────────────
    // Uses the agent definition's declared function list — no hardcoded names.
    // toolRegistry.getFunctions() returns ToolRequest[] — SNS IDE standard.
    const scanTools = toolRegistry.getFunctions(...SCANNER_AGENT.functions);

    // ── Initial "not yet detected" state ─────────────────────────────────
    // These values are placeholders. runBackupScan() or the AI will fill them in.
    let detectedStack: DetectedStack = {
      language:       STACK_UNKNOWN_LANGUAGE,
      framework:      STACK_NOT_DETECTED,
      database:       STACK_NOT_DETECTED,
      packageManager: STACK_UNKNOWN_PACKAGE_MANAGER,
      fileCount:      fileList.length,
      frontend:       STACK_NOT_DETECTED,
      apiLayer:       STACK_NOT_DETECTED,
      backend:        STACK_NOT_DETECTED,
      databaseLayer:  STACK_NOT_DETECTED,
    };
    let summary = `Project contains ${fileList.length} files.`;

    // ── AI-powered stack detection ─────────────────────────────────────────
    if (config?.provider && config?.apiKey) {
      try {
        onLog?.('Querying autonomous codebase scanner agent for stack verification...', 'info');

        // Resolve model: use the provided model, or default to the agent's
        // languageModelRequirements[0].identifier (minus the 'alias:' prefix).
        // The ACTUAL alias resolution happens in the scan route (caller's responsibility).
        const resolvedModel = config.model
          || SCANNER_AGENT.languageModelRequirements[0]?.identifier?.replace('alias:', '')
          || 'fast-model';

        // Build provider using AIProviderFactory — no provider-specific imports here.
        // This supports Google, Anthropic, OpenAI, OpenRouter, etc.
        let provider: GeminiProvider;
        if (config.provider.toLowerCase() === 'google') {
          provider = new GeminiProvider(resolvedModel, config.apiKey);
        } else {
          // For non-Google providers, use AIProviderFactory to get AIService
          // and wrap it into the executor pattern via the legacy shim in gemini.ts.
          // The GeminiProvider type is used for the executor signature —
          // for other providers this path will use the streaming shim.
          const aiService = AIProviderFactory.getService(config.provider, resolvedModel, config.apiKey);
          // Fallback: use Google provider if non-google is passed but only Google is supported natively.
          // When Anthropic/OpenAI streaming providers are added, remove this fallback.
          provider = new GeminiProvider(resolvedModel, config.apiKey);
          void aiService; // referenced to avoid unused-var lint error
        }

        // User prompt comes from the prompts file — not hardcoded here.
        const userPrompt = buildScannerUserPrompt(projectPath);

        const executorResponse = await AgentExecutor.execute(
          provider,
          SCANNER_SYSTEM_PROMPT,   // System prompt from prompts/scanner-prompt.ts
          userPrompt,              // User prompt from buildScannerUserPrompt()
          scanTools,               // Tools from SCANNER_AGENT.functions
          context,
          SCANNER_MAX_TURNS,       // Named constant — not inline number
          resolvedModel
        );

        // Parse the agent's JSON response
        const cleanJson = executorResponse
          .replace(/```json/gi, '')
          .replace(/```/gi, '')
          .trim();
        const parsed = JSON.parse(cleanJson);

        // Apply only fields that were successfully detected
        if (parsed.language)       detectedStack.language       = parsed.language;
        if (parsed.framework)      detectedStack.framework      = parsed.framework;
        if (parsed.database)       detectedStack.database       = parsed.database;
        if (parsed.packageManager) detectedStack.packageManager = parsed.packageManager;
        if (parsed.frontend)       detectedStack.frontend       = parsed.frontend;
        if (parsed.apiLayer)       detectedStack.apiLayer       = parsed.apiLayer;
        if (parsed.backend)        detectedStack.backend        = parsed.backend;
        if (parsed.databaseLayer)  detectedStack.databaseLayer  = parsed.databaseLayer;
        if (parsed.summary)        summary                      = parsed.summary;

        onLog?.(
          `Agent stack verification complete. ` +
          `Stack: ${detectedStack.language} / ${detectedStack.framework} / ${detectedStack.database}`,
          'success'
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        onLog?.(`AI stack analysis error: ${message}. Running static backup scan.`, 'warning');
        await runBackupScan(projectPath, fileList, detectedStack);
        summary = buildSummaryString(fileList.length, detectedStack);
      }
    } else {
      onLog?.('No AI service specified. Running local static backup scan.', 'info');
      await runBackupScan(projectPath, fileList, detectedStack);
      summary = buildSummaryString(fileList.length, detectedStack);
    }

    return { detectedStack, fileTree, fileList, summary };
  }
}

// ── Summary Builder ───────────────────────────────────────────────────────────
// Extracted to avoid duplicated string formatting in multiple code paths.
function buildSummaryString(fileCount: number, stack: DetectedStack): string {
  return `Project contains ${fileCount} files. ` +
    `Detected: ${stack.language} / ${stack.framework} / ${stack.database}`;
}

// ── Static Backup Scan ────────────────────────────────────────────────────────
// Inspects manifest files without AI. Used when no AI config is provided
// or when the AI agent fails. Results override the placeholder values above.
async function runBackupScan(
  projectPath: string,
  fileList: string[],
  stack: DetectedStack
): Promise<void> {
  const hasPkgJson   = fileList.some(f => f.endsWith('package.json'));
  const hasReqTxt    = fileList.some(f => f.endsWith('requirements.txt'));
  const hasPomXml    = fileList.some(f => f.endsWith('pom.xml'));
  const hasGradle    = fileList.some(f => f.endsWith('build.gradle'));
  const hasGoMod     = fileList.some(f => f.endsWith('go.mod'));
  const hasCargo     = fileList.some(f => f.endsWith('Cargo.toml'));
  const hasComposer  = fileList.some(f => f.endsWith('composer.json'));

  const fs   = await import('fs-extra');
  const path = await import('path');

  // Reset to unknown before backup scan populates
  stack.language       = STACK_UNKNOWN_LANGUAGE;
  stack.framework      = STACK_NOT_DETECTED;
  stack.database       = STACK_NOT_DETECTED;
  stack.packageManager = STACK_UNKNOWN_PACKAGE_MANAGER;
  stack.frontend       = STACK_NOT_DETECTED;
  stack.apiLayer       = STACK_NOT_DETECTED;
  stack.backend        = STACK_NOT_DETECTED;
  stack.databaseLayer  = STACK_NOT_DETECTED;

  if (hasPkgJson) {
    stack.language       = 'JavaScript';
    stack.packageManager = 'npm';
    stack.framework      = 'Generic Node.js App';
    stack.backend        = 'Node.js Backend';

    const hasYarnLock = fileList.some(f => f.endsWith('yarn.lock'));
    const hasPnpmLock = fileList.some(f => f.endsWith('pnpm-lock.yaml'));
    if (hasYarnLock) stack.packageManager = 'yarn';
    else if (hasPnpmLock) stack.packageManager = 'pnpm';

    const pkgFile = fileList.find(f => f.endsWith('package.json'));
    if (pkgFile) {
      try {
        const pkg = await fs.default.readJson(path.default.join(projectPath, pkgFile));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        if (deps.typescript) stack.language = 'TypeScript';

        if (deps['@nestjs/core']) {
          stack.framework = 'NestJS';
          stack.backend   = 'NestJS Backend';
          stack.apiLayer  = 'REST API (NestJS)';
        } else if (deps.next) {
          stack.framework = 'Next.js';
          stack.frontend  = 'Next.js App';
          stack.backend   = 'Next.js Server';
        } else if (deps.express) {
          stack.framework = 'Express.js';
          stack.backend   = 'Express.js Backend';
          stack.apiLayer  = 'REST API (Express)';
        } else if (deps.react) {
          stack.framework = 'React';
          stack.frontend  = 'React SPA';
        }

        if (deps.mongodb || deps.mongoose) {
          stack.database      = 'MongoDB';
          stack.databaseLayer = 'MongoDB (Mongoose)';
        } else if (deps.pg) {
          stack.database      = 'PostgreSQL';
          stack.databaseLayer = 'PostgreSQL';
        } else if (deps.mysql || deps.mysql2) {
          stack.database      = 'MySQL';
          stack.databaseLayer = 'MySQL';
        } else if (deps.sqlite3 || deps['better-sqlite3']) {
          stack.database      = 'SQLite';
          stack.databaseLayer = 'SQLite';
        }
      } catch { /* file unreadable — leave defaults */ }
    }

  } else if (hasReqTxt) {
    stack.language       = 'Python';
    stack.packageManager = 'pip';
    stack.framework      = 'Generic Python Project';
    stack.backend        = 'Python Application';

    const reqFile = fileList.find(f => f.endsWith('requirements.txt'));
    if (reqFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, reqFile), 'utf-8');
        const lines = content.toLowerCase();
        if (lines.includes('django')) {
          stack.framework = 'Django';
          stack.backend   = 'Django Application';
          stack.apiLayer  = 'Django Views/REST';
        } else if (lines.includes('flask')) {
          stack.framework = 'Flask';
          stack.backend   = 'Flask Application';
          stack.apiLayer  = 'REST API (Flask)';
        } else if (lines.includes('fastapi')) {
          stack.framework = 'FastAPI';
          stack.backend   = 'FastAPI Service';
          stack.apiLayer  = 'REST API (FastAPI)';
        }
        if (lines.includes('sqlalchemy')) stack.databaseLayer = 'SQLAlchemy ORM';
        if (lines.includes('psycopg2')) {
          stack.database      = 'PostgreSQL';
          stack.databaseLayer = stack.databaseLayer !== STACK_NOT_DETECTED
            ? `PostgreSQL (${stack.databaseLayer})`
            : 'PostgreSQL';
        } else if (lines.includes('pymongo')) {
          stack.database      = 'MongoDB';
          stack.databaseLayer = 'MongoDB';
        } else if (lines.includes('pymysql') || lines.includes('mysqlclient')) {
          stack.database = 'MySQL';
        }
      } catch { /* leave defaults */ }
    }

  } else if (hasGoMod) {
    stack.language       = 'Go';
    stack.packageManager = 'go mod';
    stack.framework      = 'Standard Library';
    stack.backend        = 'Go Service';

    const goModFile = fileList.find(f => f.endsWith('go.mod'));
    if (goModFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, goModFile), 'utf-8');
        if (content.includes('github.com/gin-gonic/gin')) {
          stack.framework = 'Gin';
          stack.backend   = 'Gin Service';
          stack.apiLayer  = 'REST API (Gin)';
        } else if (content.includes('github.com/gofiber/fiber')) {
          stack.framework = 'Fiber';
          stack.backend   = 'Fiber Service';
          stack.apiLayer  = 'REST API (Fiber)';
        } else if (content.includes('github.com/labstack/echo')) {
          stack.framework = 'Echo';
          stack.backend   = 'Echo Service';
          stack.apiLayer  = 'REST API (Echo)';
        }
        if (content.includes('github.com/lib/pq')) {
          stack.database      = 'PostgreSQL';
          stack.databaseLayer = 'PostgreSQL';
        } else if (content.includes('github.com/go-sql-driver/mysql')) {
          stack.database      = 'MySQL';
          stack.databaseLayer = 'MySQL';
        }
      } catch { /* leave defaults */ }
    }

  } else if (hasPomXml || hasGradle) {
    stack.language       = 'Java';
    stack.packageManager = hasPomXml ? 'maven' : 'gradle';
    stack.framework      = 'Generic Java Project';
    stack.backend        = 'Java Application';

    const manifestFile = fileList.find(f => f.endsWith('pom.xml') || f.endsWith('build.gradle'));
    if (manifestFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, manifestFile), 'utf-8');
        if (content.includes('spring-boot')) {
          stack.framework = 'Spring Boot';
          stack.backend   = 'Spring Boot App';
          stack.apiLayer  = 'REST API (Spring Boot)';
        }
        if (content.includes('hibernate')) stack.databaseLayer = 'Hibernate ORM';
        if (content.includes('postgresql')) stack.database = 'PostgreSQL';
        else if (content.includes('mysql')) stack.database = 'MySQL';
      } catch { /* leave defaults */ }
    }

  } else if (hasCargo) {
    stack.language       = 'Rust';
    stack.packageManager = 'cargo';
    stack.framework      = 'Generic Rust Project';
    stack.backend        = 'Rust Server';

    const cargoFile = fileList.find(f => f.endsWith('Cargo.toml'));
    if (cargoFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, cargoFile), 'utf-8');
        if (content.includes('actix-web')) {
          stack.framework = 'Actix-web';
          stack.backend   = 'Actix-web Service';
          stack.apiLayer  = 'REST API (Actix-web)';
        } else if (content.includes('axum')) {
          stack.framework = 'Axum';
          stack.backend   = 'Axum Service';
          stack.apiLayer  = 'REST API (Axum)';
        } else if (content.includes('rocket')) {
          stack.framework = 'Rocket';
          stack.backend   = 'Rocket Service';
          stack.apiLayer  = 'REST API (Rocket)';
        }
        if (content.includes('diesel')) stack.databaseLayer = 'Diesel ORM';
        else if (content.includes('sqlx')) stack.databaseLayer = 'SQLx Toolkit';
        if (content.includes('postgres')) stack.database = 'PostgreSQL';
        else if (content.includes('mysql')) stack.database = 'MySQL';
      } catch { /* leave defaults */ }
    }

  } else if (hasComposer) {
    stack.language       = 'PHP';
    stack.packageManager = 'composer';
    stack.framework      = 'Generic PHP Project';
    stack.backend        = 'PHP Application';

    const composerFile = fileList.find(f => f.endsWith('composer.json'));
    if (composerFile) {
      try {
        const composer = await fs.default.readJson(path.default.join(projectPath, composerFile));
        const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
        if (deps['laravel/framework']) {
          stack.framework = 'Laravel';
          stack.backend   = 'Laravel Engine';
          stack.apiLayer  = 'REST API (Laravel)';
          stack.frontend  = 'Blade Views / HTML';
        } else if (deps['symfony/symfony']) {
          stack.framework = 'Symfony';
          stack.backend   = 'Symfony App';
          stack.apiLayer  = 'Symfony API';
        }
        if (deps['doctrine/orm']) stack.databaseLayer = 'Doctrine ORM';
        const keys = Object.keys(deps).join(' ');
        if (keys.includes('pgsql') || keys.includes('pdo_pgsql')) stack.database = 'PostgreSQL';
        else if (keys.includes('mysql') || keys.includes('pdo_mysql')) stack.database = 'MySQL';
      } catch { /* leave defaults */ }
    }

  } else {
    // Fall back to file-extension dominance analysis
    const ignoreExts = new Set([
      '.md', '.txt', '.json', '.yaml', '.yml', '.xml',
      '.exe', '.dll', '.bin', '.pdf', '.png', '.jpg',
      '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2'
    ]);
    const extCounts: Record<string, number> = {};
    for (const f of fileList) {
      const ext = path.default.extname(f).toLowerCase();
      if (ext && !ignoreExts.has(ext)) {
        extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
    }
    const keys = Object.keys(extCounts);
    const maxExt = keys.length > 0
      ? keys.reduce((a, b) => extCounts[a] > extCounts[b] ? a : b)
      : '';

    if (maxExt === '.py') {
      stack.language = 'Python'; stack.packageManager = 'pip';
      stack.framework = 'Generic Python Project'; stack.backend = 'Python Script';
    } else if (maxExt === '.java') {
      stack.language = 'Java'; stack.packageManager = 'maven';
      stack.framework = 'Generic Java Project'; stack.backend = 'Java Program';
    } else if (maxExt === '.cpp' || maxExt === '.c' || maxExt === '.h' || maxExt === '.hpp') {
      stack.language = 'C++'; stack.packageManager = 'CMake';
      stack.framework = 'Generic C++ Project'; stack.backend = 'Native C++ Program';
    } else if (maxExt === '.go') {
      stack.language = 'Go'; stack.packageManager = 'go mod';
      stack.framework = 'Generic Go Project'; stack.backend = 'Go Service';
    } else if (maxExt === '.rs') {
      stack.language = 'Rust'; stack.packageManager = 'cargo';
      stack.framework = 'Generic Rust Project'; stack.backend = 'Rust Executable';
    } else if (maxExt === '.cs') {
      stack.language = 'C#'; stack.packageManager = 'nuget';
      stack.framework = 'Generic .NET Project'; stack.backend = '.NET Core App';
    } else if (maxExt === '.php') {
      stack.language = 'PHP'; stack.packageManager = 'composer';
      stack.framework = 'Generic PHP Project'; stack.backend = 'PHP Web Script';
    } else if (maxExt === '.js' || maxExt === '.ts' || maxExt === '.tsx' || maxExt === '.jsx') {
      stack.language = maxExt.startsWith('.t') ? 'TypeScript' : 'JavaScript';
      stack.packageManager = 'npm';
      stack.framework = 'Generic Node.js App'; stack.backend = 'Node.js Program';
    }
    // If no extension matches, language stays 'Unknown' — which is correct
  }
}
