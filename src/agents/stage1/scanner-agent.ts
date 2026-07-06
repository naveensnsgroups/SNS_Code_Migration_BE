import { scanProjectDirectory, computeFilteredFileCount, findManifestFiles } from '../../tools/fileScanner.js';
import fs   from 'fs-extra';
import path from 'path';
import { DetectedStack, FileNode } from '../../types.js';
import { toolRegistry } from '../../core/tool-invocation-registry.js';
import { ToolContext } from '../../types/tool.js';
import { AgentExecutor } from '../core/agentExecutor.js';
import { AIProviderFactory } from '../../ai/provider.js';
import { StreamingProvider } from '../../types/language-model.js';
import { SCANNER_SYSTEM_PROMPT, buildScannerUserPrompt } from '../../prompts/scanner-prompt.js';
import { SCANNER_AGENT } from '../core/agent-definitions.js';

const STACK_NOT_DETECTED            = 'Not Detected';
const STACK_UNKNOWN_LANGUAGE        = 'Unknown';
const STACK_UNKNOWN_PACKAGE_MANAGER = 'Not Detected';

export interface ScanAgentResult {
  detectedStack:     DetectedStack;
  fileTree:          FileNode[];
  fileList:          string[];
  filteredFileCount: number;
  rawFileCount:      number;
  confidence:        'ai' | 'backup' | 'extension-fallback';
  manifestsFound:    string[];
  summary:           string;
}

export interface ScannerAgentConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  maxRetries?: number;
  retryDelayRateLimit?: number;
  retryDelayOther?: number;
  timeoutMs?: number;
}

export class ScannerAgent {
  static async run(
    projectPath: string,
    modernPath:  string,
    config?:     ScannerAgentConfig,
    onLog?:      (message: string, level?: 'info' | 'success' | 'error' | 'warning') => void
  ): Promise<ScanAgentResult> {
    const cached = await readCachedScanResult(modernPath, onLog);
    if (cached) return cached;

    onLog?.('Scanning directory structure...', 'info');
    const { fileTree, fileList } = await scanProjectDirectory(projectPath);

    const rawFileCount      = fileList.length;
    const filteredFileCount = computeFilteredFileCount(fileList);
    const manifestFiles     = findManifestFiles(fileList);
    onLog?.(
      `[Phase 0] ${rawFileCount} total files. ` +
      `${filteredFileCount} source files (filtered). ` +
      `${manifestFiles.length} manifest file(s) detected.`,
      'info'
    );

    const sessionId = `scan-${Date.now().toString(36)}`;
    const context: ToolContext = {
      sessionId,
      legacyPath: projectPath,
      modernPath:  projectPath,
      onLog: (msg, lvl) => onLog?.(msg, lvl),
    };

    const scanTools = toolRegistry.getFunctions(...SCANNER_AGENT.functions);

    let detectedStack: DetectedStack = {
      language:            STACK_UNKNOWN_LANGUAGE,
      framework:           STACK_NOT_DETECTED,
      database:            STACK_NOT_DETECTED,
      packageManager:      STACK_UNKNOWN_PACKAGE_MANAGER,
      fileCount:           filteredFileCount,
      frontend:            STACK_NOT_DETECTED,
      apiLayer:            STACK_NOT_DETECTED,
      backend:             STACK_NOT_DETECTED,
      databaseLayer:       STACK_NOT_DETECTED,
      cloudInfrastructure: STACK_NOT_DETECTED,
    };
    let summary    = `Project contains ${filteredFileCount} source files.`;
    let confidence: ScanAgentResult['confidence'] = 'extension-fallback';

    if (config?.provider && config?.apiKey) {
      try {
        onLog?.('Querying autonomous codebase scanner agent for stack verification...', 'info');

        const resolvedModel = config.model
          || SCANNER_AGENT.languageModelRequirements[0]?.identifier?.replace('alias:', '')
          || 'fast-model';

        const providerConfig = {
          maxRetries:           config.maxRetries,
          retryDelayRateLimit:  config.retryDelayRateLimit,
          retryDelayOther:      config.retryDelayOther,
        };

        const provider: StreamingProvider = AIProviderFactory.getStreamingProvider(
          config.provider,
          resolvedModel,
          config.apiKey,
          providerConfig
        );

        const userPrompt = buildScannerUserPrompt(projectPath, rawFileCount, manifestFiles);

        const executorResponse = await AgentExecutor.execute(
          provider,
          SCANNER_SYSTEM_PROMPT,
          userPrompt,
          scanTools,
          context,
          resolvedModel,
          'scanner-agent'
        );

        const stripped = executorResponse
          .replace(/```json\s*/gi, '')
          .replace(/```\s*/gi, '')
          .trim();

        const jsonToParse = extractFirstJsonObject(stripped);

        let parsed: Record<string, string> = {};
        try {
          parsed = JSON.parse(jsonToParse);
        } catch (err: any) {
          onLog?.(
            `[Phase 0] AI scanner returned non-JSON response. Error: ${err.message}. ` +
            'Stack left as Not Detected — Phase 1 Discovery will classify.',
            'warning'
          );
        }

        if (parsed.language)            detectedStack.language            = parsed.language;
        if (parsed.framework)           detectedStack.framework           = parsed.framework;
        if (parsed.database)            detectedStack.database            = parsed.database;
        if (parsed.packageManager)      detectedStack.packageManager      = parsed.packageManager;
        if (parsed.frontend)            detectedStack.frontend            = parsed.frontend;
        if (parsed.apiLayer)            detectedStack.apiLayer            = parsed.apiLayer;
        if (parsed.backend)             detectedStack.backend             = parsed.backend;
        if (parsed.databaseLayer)       detectedStack.databaseLayer       = parsed.databaseLayer;
        if (parsed.cloudInfrastructure) detectedStack.cloudInfrastructure = parsed.cloudInfrastructure;
        if (parsed.summary)             summary                           = parsed.summary;

        const aiDetectedAnything = !!(parsed.language || parsed.framework || parsed.backend);
        if (!aiDetectedAnything) {
          onLog?.(
            '[Phase 0] AI agent returned no structured fields. ' +
            'Stack left as Not Detected — Phase 1 Discovery will classify.',
            'warning'
          );
          confidence = 'extension-fallback';
        } else {
          confidence = 'ai';
        }

        onLog?.(
          `[Phase 0] Stack detection complete. ` +
          `Detected: ${detectedStack.language} / ${detectedStack.framework} / ${detectedStack.database}`,
          'success'
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        onLog?.(
          `[Phase 0] AI stack analysis error: ${message}. ` +
          'Stack left as Not Detected — Phase 1 Discovery will classify.',
          'warning'
        );
        confidence = 'extension-fallback';
      }
    } else {
      onLog?.(
        '[Phase 0] No AI provider configured. ' +
        'Stack left as Not Detected — Phase 1 Discovery will classify.',
        'info'
      );
      confidence = 'extension-fallback';
    }

    detectedStack.fileCount = filteredFileCount;
    summary = buildSummaryString(filteredFileCount, detectedStack);

    await writeScanResult(modernPath, detectedStack, filteredFileCount, rawFileCount, confidence, manifestFiles, summary);

    return {
      detectedStack,
      fileTree,
      fileList,
      filteredFileCount,
      rawFileCount,
      confidence,
      manifestsFound: manifestFiles,
      summary,
    };
  }
}

function buildSummaryString(fileCount: number, stack: DetectedStack): string {
  return `Project contains ${fileCount} source files. ` +
    `Detected: ${stack.language} / ${stack.framework} / ${stack.database}`;
}

async function readCachedScanResult(
  modernPath: string,
  onLog?: (msg: string, level?: 'info' | 'success' | 'error' | 'warning') => void
): Promise<ScanAgentResult | null> {
  try {
    const resultFile = path.join(modernPath, '_analysis', 'scan-result.json');
    if (await fs.pathExists(resultFile)) {
      const cached = await fs.readJson(resultFile) as Record<string, any>;
      onLog?.(
        `[Phase 0] scan-result.json found on disk (scanned: ${cached.scannedAt ?? 'unknown'}). ` +
        `Skipping re-scan — using cached result.`,
        'info'
      );
      return {
        detectedStack: {
          language:            cached.language            ?? STACK_UNKNOWN_LANGUAGE,
          framework:           cached.framework           ?? STACK_NOT_DETECTED,
          database:            cached.database            ?? STACK_NOT_DETECTED,
          packageManager:      cached.packageManager      ?? STACK_UNKNOWN_PACKAGE_MANAGER,
          fileCount:           cached.filteredFileCount   ?? 0,
          frontend:            cached.frontend            ?? STACK_NOT_DETECTED,
          apiLayer:            cached.apiLayer            ?? STACK_NOT_DETECTED,
          backend:             cached.backend             ?? STACK_NOT_DETECTED,
          databaseLayer:       cached.databaseLayer       ?? STACK_NOT_DETECTED,
          cloudInfrastructure: cached.cloudInfrastructure ?? STACK_NOT_DETECTED,
        },
        fileTree:          [],
        fileList:          [],
        filteredFileCount: cached.filteredFileCount ?? 0,
        rawFileCount:      cached.rawFileCount      ?? 0,
        confidence:        (cached.confidence as ScanAgentResult['confidence']) ?? 'extension-fallback',
        manifestsFound:    cached.manifestsFound    ?? [],
        summary:           cached.summary           ?? '',
      };
    }
  } catch {
    
  }
  return null;
}

async function writeScanResult(
  modernPath:        string,
  detectedStack:     DetectedStack,
  filteredFileCount: number,
  rawFileCount:      number,
  confidence:        ScanAgentResult['confidence'],
  manifestsFound:    string[],
  summary:           string
): Promise<void> {
  try {
    const analysisDir = path.join(modernPath, '_analysis');
    await fs.ensureDir(analysisDir);
    await fs.writeJson(
      path.join(analysisDir, 'scan-result.json'),
      {
        language:            detectedStack.language,
        framework:           detectedStack.framework,
        database:            detectedStack.database,
        packageManager:      detectedStack.packageManager,
        frontend:            detectedStack.frontend,
        apiLayer:            detectedStack.apiLayer,
        backend:             detectedStack.backend,
        databaseLayer:       detectedStack.databaseLayer,
        cloudInfrastructure: detectedStack.cloudInfrastructure,
        filteredFileCount,
        rawFileCount,
        confidence,
        manifestsFound,
        summary,
        scannedAt: new Date().toISOString(),
      },
      { spaces: 2 }
    );
  } catch (err) {
    console.warn('[Phase 0] Could not write scan-result.json:', err);
  }
}

function extractFirstJsonObject(text: string): string {
  const withoutComments = removeLineComments(text);
  const start = withoutComments.indexOf('{');
  if (start === -1) return text.trim();

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (escape)               { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"')           { inString = !inString; continue; }
    if (inString)             continue;
    if (ch === '{')           depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) return withoutComments.trim();
  return removeTrailingCommas(withoutComments.slice(start, end + 1));
}

function removeLineComments(text: string): string {
  return text.split('\n').map(line => {
    let inStr = false;
    let esc = false;
    for (let i = 0; i < line.length - 1; i++) {
      const ch = line[i];
      if (esc)         { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"')  { inStr = !inStr; continue; }
      if (!inStr && ch === '/' && line[i + 1] === '/') {
        if (/https?:\s*$/.test(line.slice(0, i))) continue;
        return line.slice(0, i).trimEnd();
      }
    }
    return line;
  }).join('\n');
}

function removeTrailingCommas(str: string): string {
  return str.replace(/,(\s*[}\]])/g, '$1');
}
