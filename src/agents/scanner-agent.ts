import { scanProjectDirectory } from '../tools/fileScanner.js';
import { AIService } from '../ai/provider.js';
import { DetectedStack, FileNode } from '../types.js';
import { TOOLS_REGISTRY, ToolContext } from '../tools/registry.js';
import { AgentExecutor } from './agentExecutor.js';
import { SCANNER_SYSTEM_PROMPT } from '../prompts/scanner-prompt.js';

export interface ScanAgentResult {
  detectedStack: DetectedStack;
  fileTree: FileNode[];
  fileList: string[];
  summary: string;
}

export class ScannerAgent {
  /**
   * Scans the project directory and detects the code stack.
   */
  static async run(
    projectPath: string,
    aiService?: AIService,
    onLog?: (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<ScanAgentResult> {
    onLog?.('Scanning directory structure...', 'info');
    const { fileTree, fileList } = await scanProjectDirectory(projectPath);

    onLog?.(`Found ${fileList.length} files. Analyzing stack manifests...`, 'info');

    const context: ToolContext = {
      sessionId: 'scan-' + Math.random().toString(36).substring(2, 10),
      legacyPath: projectPath,
      modernPath: projectPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl)
    };

    const enabledTools = [
      TOOLS_REGISTRY.getWorkspaceDirectoryStructure,
      TOOLS_REGISTRY.getWorkspaceFileList,
      TOOLS_REGISTRY.getFileContent,
      TOOLS_REGISTRY.getDependencyTree,
      TOOLS_REGISTRY.findFilesByPattern,
    ];

    let detectedStack: DetectedStack = {
      language: 'JavaScript',
      framework: 'Express.js',
      database: 'SQLite',
      packageManager: 'npm',
      fileCount: fileList.length,
      frontend: 'Not Detected',
      apiLayer: 'Not Detected',
      backend: 'Not Detected',
      databaseLayer: 'Not Detected',
    };
    let summary = `Project contains ${fileList.length} files.`;

    if (aiService) {
      try {
        onLog?.('Querying autonomous codebase scanner agent for stack verification...', 'info');
        
        const executorResponse = await AgentExecutor.execute(
          aiService,
          `Inspect the codebase structure at "${projectPath}" and detect its stack.`,
          SCANNER_SYSTEM_PROMPT,
          enabledTools,
          context,
          10 // 10 turns max for scanner agent
        );

        const cleanJson = executorResponse.replace(/```json/gi, '').replace(/```/gi, '').trim();
        const parsed = JSON.parse(cleanJson);

        if (parsed.language) detectedStack.language = parsed.language;
        if (parsed.framework) detectedStack.framework = parsed.framework;
        if (parsed.database) detectedStack.database = parsed.database;
        if (parsed.packageManager) detectedStack.packageManager = parsed.packageManager;
        if (parsed.frontend) detectedStack.frontend = parsed.frontend;
        if (parsed.apiLayer) detectedStack.apiLayer = parsed.apiLayer;
        if (parsed.backend) detectedStack.backend = parsed.backend;
        if (parsed.databaseLayer) detectedStack.databaseLayer = parsed.databaseLayer;
        if (parsed.summary) summary = parsed.summary;

        onLog?.(`Agent stack verification complete. Stack: ${detectedStack.language} / ${detectedStack.framework} / ${detectedStack.database}`, 'success');
      } catch (err: any) {
        onLog?.(`AI stack analysis error: ${err.message}. Running static backup scan.`, 'warning');
        await runBackupScan(projectPath, fileList, detectedStack);
        summary = `Project contains ${fileList.length} files. Backup scan detected: ${detectedStack.language} / ${detectedStack.framework}.`;
      }
    } else {
      onLog?.('No AI service specified. Running local static backup scan.', 'info');
      await runBackupScan(projectPath, fileList, detectedStack);
      summary = `Project contains ${fileList.length} files. Backup scan detected: ${detectedStack.language} / ${detectedStack.framework}.`;
    }

    return {
      detectedStack,
      fileTree,
      fileList,
      summary,
    };
  }
}

async function runBackupScan(projectPath: string, fileList: string[], stack: DetectedStack) {
  const hasPkgJson = fileList.some(f => f.endsWith('package.json'));
  const hasReqTxt = fileList.some(f => f.endsWith('requirements.txt'));
  const hasPomXml = fileList.some(f => f.endsWith('pom.xml'));
  const hasGradle = fileList.some(f => f.endsWith('build.gradle'));
  const hasGoMod = fileList.some(f => f.endsWith('go.mod'));
  const hasCargo = fileList.some(f => f.endsWith('Cargo.toml'));
  const hasComposer = fileList.some(f => f.endsWith('composer.json'));

  const fs = await import('fs-extra');
  const path = await import('path');

  // Set default values for all stack layers first
  stack.language = 'Unknown';
  stack.framework = 'Not Detected';
  stack.database = 'Not Detected';
  stack.packageManager = 'None';
  stack.frontend = 'Not Detected';
  stack.apiLayer = 'Not Detected';
  stack.backend = 'Not Detected';
  stack.databaseLayer = 'Not Detected';

  if (hasPkgJson) {
    stack.language = 'JavaScript';
    stack.packageManager = 'npm';
    stack.framework = 'Generic Node.js App';
    stack.backend = 'Node.js Backend';

    const hasYarnLock = fileList.some(f => f.endsWith('yarn.lock'));
    const hasPnpmLock = fileList.some(f => f.endsWith('pnpm-lock.yaml'));
    if (hasYarnLock) stack.packageManager = 'yarn';
    else if (hasPnpmLock) stack.packageManager = 'pnpm';

    const pkgFile = fileList.find(f => f.endsWith('package.json'));
    if (pkgFile) {
      try {
        const pkg = await fs.default.readJson(path.default.join(projectPath, pkgFile));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        
        if (deps.typescript) {
          stack.language = 'TypeScript';
        }
        
        if (deps['@nestjs/core']) {
          stack.framework = 'NestJS';
          stack.backend = 'NestJS Backend';
          stack.apiLayer = 'REST API (NestJS)';
        } else if (deps.next) {
          stack.framework = 'Next.js';
          stack.frontend = 'Next.js App';
          stack.backend = 'Next.js Server';
        } else if (deps.express) {
          stack.framework = 'Express.js';
          stack.backend = 'Express.js Backend';
          stack.apiLayer = 'REST API (Express)';
        } else if (deps.react) {
          stack.framework = 'React';
          stack.frontend = 'React SPA';
        }

        if (deps.mongodb || deps.mongoose) {
          stack.database = 'MongoDB';
          stack.databaseLayer = 'MongoDB (Mongoose)';
        } else if (deps.pg) {
          stack.database = 'PostgreSQL';
          stack.databaseLayer = 'PostgreSQL';
        } else if (deps.mysql || deps.mysql2) {
          stack.database = 'MySQL';
          stack.databaseLayer = 'MySQL';
        } else if (deps.sqlite3 || deps['better-sqlite3']) {
          stack.database = 'SQLite';
          stack.databaseLayer = 'SQLite';
        }
      } catch {}
    }
  } else if (hasReqTxt) {
    stack.language = 'Python';
    stack.packageManager = 'pip';
    stack.framework = 'Generic Python Project';
    stack.backend = 'Python Application';

    const reqFile = fileList.find(f => f.endsWith('requirements.txt'));
    if (reqFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, reqFile), 'utf-8');
        const lines = content.toLowerCase();
        
        if (lines.includes('django')) {
          stack.framework = 'Django';
          stack.backend = 'Django Application';
          stack.apiLayer = 'Django Views/REST';
        } else if (lines.includes('flask')) {
          stack.framework = 'Flask';
          stack.backend = 'Flask Application';
          stack.apiLayer = 'REST API (Flask)';
        } else if (lines.includes('fastapi')) {
          stack.framework = 'FastAPI';
          stack.backend = 'FastAPI Service';
          stack.apiLayer = 'REST API (FastAPI)';
        }

        if (lines.includes('sqlalchemy')) {
          stack.databaseLayer = 'SQLAlchemy ORM';
        }

        if (lines.includes('psycopg2')) {
          stack.database = 'PostgreSQL';
          stack.databaseLayer = stack.databaseLayer !== 'Not Detected' ? `PostgreSQL (${stack.databaseLayer})` : 'PostgreSQL';
        } else if (lines.includes('pymongo')) {
          stack.database = 'MongoDB';
          stack.databaseLayer = 'MongoDB';
        } else if (lines.includes('pymysql') || lines.includes('mysqlclient')) {
          stack.database = 'MySQL';
        }
      } catch {}
    }
  } else if (hasGoMod) {
    stack.language = 'Go';
    stack.packageManager = 'go mod';
    stack.framework = 'Standard Library';
    stack.backend = 'Go Service';

    const goModFile = fileList.find(f => f.endsWith('go.mod'));
    if (goModFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, goModFile), 'utf-8');
        
        if (content.includes('github.com/gin-gonic/gin')) {
          stack.framework = 'Gin';
          stack.backend = 'Gin Service';
          stack.apiLayer = 'REST API (Gin)';
        } else if (content.includes('github.com/gofiber/fiber')) {
          stack.framework = 'Fiber';
          stack.backend = 'Fiber Service';
          stack.apiLayer = 'REST API (Fiber)';
        } else if (content.includes('github.com/labstack/echo')) {
          stack.framework = 'Echo';
          stack.backend = 'Echo Service';
          stack.apiLayer = 'REST API (Echo)';
        }

        if (content.includes('github.com/lib/pq')) {
          stack.database = 'PostgreSQL';
          stack.databaseLayer = 'PostgreSQL';
        } else if (content.includes('github.com/go-sql-driver/mysql')) {
          stack.database = 'MySQL';
          stack.databaseLayer = 'MySQL';
        }
      } catch {}
    }
  } else if (hasPomXml || hasGradle) {
    stack.language = 'Java';
    stack.packageManager = hasPomXml ? 'maven' : 'gradle';
    stack.framework = 'Generic Java Project';
    stack.backend = 'Java Application';

    const manifestFile = fileList.find(f => f.endsWith('pom.xml') || f.endsWith('build.gradle'));
    if (manifestFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, manifestFile), 'utf-8');
        
        if (content.includes('spring-boot')) {
          stack.framework = 'Spring Boot';
          stack.backend = 'Spring Boot App';
          stack.apiLayer = 'REST API (Spring Boot)';
        }

        if (content.includes('hibernate')) {
          stack.databaseLayer = 'Hibernate ORM';
        }

        if (content.includes('postgresql')) {
          stack.database = 'PostgreSQL';
        } else if (content.includes('mysql')) {
          stack.database = 'MySQL';
        }
      } catch {}
    }
  } else if (hasCargo) {
    stack.language = 'Rust';
    stack.packageManager = 'cargo';
    stack.framework = 'Generic Rust Project';
    stack.backend = 'Rust Server';

    const cargoFile = fileList.find(f => f.endsWith('Cargo.toml'));
    if (cargoFile) {
      try {
        const content = await fs.default.readFile(path.default.join(projectPath, cargoFile), 'utf-8');
        
        if (content.includes('actix-web')) {
          stack.framework = 'Actix-web';
          stack.backend = 'Actix-web Service';
          stack.apiLayer = 'REST API (Actix-web)';
        } else if (content.includes('axum')) {
          stack.framework = 'Axum';
          stack.backend = 'Axum Service';
          stack.apiLayer = 'REST API (Axum)';
        } else if (content.includes('rocket')) {
          stack.framework = 'Rocket';
          stack.backend = 'Rocket Service';
          stack.apiLayer = 'REST API (Rocket)';
        }

        if (content.includes('diesel')) {
          stack.databaseLayer = 'Diesel ORM';
        } else if (content.includes('sqlx')) {
          stack.databaseLayer = 'SQLx Toolkit';
        }

        if (content.includes('postgres')) {
          stack.database = 'PostgreSQL';
        } else if (content.includes('mysql')) {
          stack.database = 'MySQL';
        }
      } catch {}
    }
  } else if (hasComposer) {
    stack.language = 'PHP';
    stack.packageManager = 'composer';
    stack.framework = 'Generic PHP Project';
    stack.backend = 'PHP Application';

    const composerFile = fileList.find(f => f.endsWith('composer.json'));
    if (composerFile) {
      try {
        const composer = await fs.default.readJson(path.default.join(projectPath, composerFile));
        const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
        
        if (deps['laravel/framework']) {
          stack.framework = 'Laravel';
          stack.backend = 'Laravel Engine';
          stack.apiLayer = 'REST API (Laravel)';
          stack.frontend = 'Blade Views / HTML';
        } else if (deps['symfony/symfony']) {
          stack.framework = 'Symfony';
          stack.backend = 'Symfony App';
          stack.apiLayer = 'Symfony API';
        }

        if (deps['doctrine/orm']) {
          stack.databaseLayer = 'Doctrine ORM';
        }

        const keys = Object.keys(deps).join(' ');
        if (keys.includes('pgsql') || keys.includes('pdo_pgsql')) {
          stack.database = 'PostgreSQL';
        } else if (keys.includes('mysql') || keys.includes('pdo_mysql')) {
          stack.database = 'MySQL';
        }
      } catch {}
    }
  } else {
    // Fall back to extension inspection
    const ignoreExts = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.exe', '.dll', '.bin', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.ico']);
    const extCounts: Record<string, number> = {};
    for (const f of fileList) {
      const ext = path.default.extname(f).toLowerCase();
      if (ext && !ignoreExts.has(ext)) {
        extCounts[ext] = (extCounts[ext] || 0) + 1;
      }
    }
    const keys = Object.keys(extCounts);
    const maxExt = keys.length > 0 ? keys.reduce((a, b) => extCounts[a] > extCounts[b] ? a : b) : '';

    if (maxExt === '.py') {
      stack.language = 'Python';
      stack.packageManager = 'pip';
      stack.framework = 'Generic Python Project';
      stack.backend = 'Python Script';
    } else if (maxExt === '.java') {
      stack.language = 'Java';
      stack.packageManager = 'maven';
      stack.framework = 'Generic Java Project';
      stack.backend = 'Java Program';
    } else if (maxExt === '.cpp' || maxExt === '.c' || maxExt === '.h' || maxExt === '.hpp') {
      stack.language = 'C++';
      stack.packageManager = 'CMake';
      stack.framework = 'Generic C++ Project';
      stack.backend = 'Native C++ Program';
    } else if (maxExt === '.go') {
      stack.language = 'Go';
      stack.packageManager = 'go mod';
      stack.framework = 'Generic Go Project';
      stack.backend = 'Go Service';
    } else if (maxExt === '.rs') {
      stack.language = 'Rust';
      stack.packageManager = 'cargo';
      stack.framework = 'Generic Rust Project';
      stack.backend = 'Rust Executable';
    } else if (maxExt === '.cs') {
      stack.language = 'C#';
      stack.packageManager = 'nuget';
      stack.framework = 'Generic .NET Project';
      stack.backend = '.NET Core App';
    } else if (maxExt === '.php') {
      stack.language = 'PHP';
      stack.packageManager = 'composer';
      stack.framework = 'Generic PHP Project';
      stack.backend = 'PHP Web Script';
    } else if (maxExt === '.js' || maxExt === '.ts' || maxExt === '.tsx' || maxExt === '.jsx') {
      stack.language = maxExt.startsWith('.t') ? 'TypeScript' : 'JavaScript';
      stack.packageManager = 'npm';
      stack.framework = 'Generic Node.js App';
      stack.backend = 'Node.js Program';
    } else {
      stack.language = 'Plain Text / Other';
      stack.packageManager = 'None';
      stack.framework = 'Not Detected';
      stack.backend = 'Not Detected';
    }
  }
}
