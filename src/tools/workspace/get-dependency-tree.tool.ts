

import fs from 'fs-extra';
import path from 'path';
import glob from 'fast-glob';
import { ToolRequest } from '../../types/tool.js';

import { ToolContext } from '../../types/tool.js';
import { makeToolTextResult, makeToolErrorResult } from '../../types/language-model.js';

import { GET_DEPENDENCY_TREE_FUNCTION_ID } from '../../common/workspace-functions.js';

function parsePackageJson(content: string) {
  try {
    const pkg = JSON.parse(content);
    return { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {}, peerDependencies: pkg.peerDependencies || {}, scripts: pkg.scripts || {} };
  } catch { return { dependencies: {}, devDependencies: {} }; }
}

function parseRequirementsTxt(content: string) {
  const deps: Record<string, string> = {};
  content.split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('-')) return;
    const m = t.match(/^([a-zA-Z0-9_\-\[\]]+)([><=!~^]+.+)?$/);
    if (m) deps[m[1]] = m[2]?.trim() || '*';
  });
  return { dependencies: deps };
}

function parsePipfile(content: string) {
  const deps: Record<string, string> = {};
  let inPackages = false;
  content.split('\n').forEach(line => {
    if (line.trim() === '[packages]') { inPackages = true; return; }
    if (line.startsWith('[') && line.trim() !== '[packages]') { inPackages = false; }
    if (inPackages) { const m = line.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"?(.+?)"?$/); if (m) deps[m[1]] = m[2]; }
  });
  return { dependencies: deps };
}

function parsePomXml(content: string) {
  const deps: Record<string, string> = {};
  const re = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
  let m;
  while ((m = re.exec(content)) !== null) deps[`${m[1]}:${m[2]}`] = m[3] || '*';
  return { dependencies: deps };
}

function parseBuildGradle(content: string) {
  const deps: Record<string, string> = {};
  const re = /(?:implementation|compile|api|testImplementation)\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) deps[m[1]] = '*';
  return { dependencies: deps };
}

function parseGoMod(content: string) {
  const deps: Record<string, string> = {};
  let inRequire = false;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === 'require (') { inRequire = true; continue; }
    if (t === ')' && inRequire) { inRequire = false; continue; }
    if (inRequire || t.startsWith('require ')) {
      const m = t.replace('require ', '').trim().match(/^(\S+)\s+(\S+)/);
      if (m) deps[m[1]] = m[2];
    }
  }
  return { dependencies: deps };
}

function parseCargoToml(content: string) {
  const deps: Record<string, string> = {}; const devDeps: Record<string, string> = {}; let section = '';
  content.split('\n').forEach(line => {
    const t = line.trim();
    if (t === '[dependencies]') { section = 'deps'; return; }
    if (t === '[dev-dependencies]') { section = 'dev'; return; }
    if (t.startsWith('[')) { section = ''; return; }
    const m = t.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"?([^"]+)"?/);
    if (m) { if (section === 'deps') deps[m[1]] = m[2]; else if (section === 'dev') devDeps[m[1]] = m[2]; }
  });
  return { dependencies: deps, devDependencies: devDeps };
}

function parseGemfile(content: string) {
  const deps: Record<string, string> = {};
  content.split('\n').forEach(line => {
    const t = line.trim();
    if (t.startsWith('#') || !t) return;
    const m = t.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (m) deps[m[1]] = m[2] || '*';
  });
  return { dependencies: deps };
}

function parseComposerJson(content: string) {
  try {
    const c = JSON.parse(content); const deps: Record<string, string> = {}; const devDeps: Record<string, string> = {};
    for (const [pkg, ver] of Object.entries(c.require || {})) { if (pkg !== 'php' && !pkg.startsWith('ext-')) deps[pkg] = String(ver); }
    for (const [pkg, ver] of Object.entries(c['require-dev'] || {})) devDeps[pkg] = String(ver);
    return { dependencies: deps, devDependencies: devDeps, scripts: c.scripts || {} };
  } catch { return { dependencies: {} }; }
}

function parsePyprojectToml(content: string) {
  const deps: Record<string, string> = {}; let inPoetry = false;
  content.split('\n').forEach(line => {
    if (line.trim() === '[tool.poetry.dependencies]') { inPoetry = true; return; }
    if (line.startsWith('[') && inPoetry) { inPoetry = false; return; }
    if (inPoetry) { const m = line.match(/^([a-zA-Z0-9_\-]+)\s*=\s*"?([^"]+)"?/); if (m && m[1] !== 'python') deps[m[1]] = m[2]; }
  });
  return { dependencies: deps };
}

export const getDependencyTreeTool: ToolRequest = {
  id: GET_DEPENDENCY_TREE_FUNCTION_ID,
  name: 'getDependencyTree',
  providerName: 'migration-workspace',
  description:
    'Reads and parses ALL dependency manifests in the legacy workspace ' +
    '(package.json, requirements.txt, pom.xml, go.mod, Cargo.toml, build.gradle, composer.json, Gemfile, *.csproj, pyproject.toml). ' +
    'Returns a structured JSON object with all dependency names and versions per manifest. ' +
    'Use this during Phase 1 Discovery to build the Dependency section in Stage1_Analysis.md.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional relative directory path to search (default: workspace root). Use "." or "" for root.' }
    },
    required: []
  },
  handler: async (arg_string: string, ctx?: ToolContext) => {
    const args: { path?: string } = JSON.parse(arg_string || '{}');
    const basePath = args.path ? path.resolve(ctx!.legacyPath, args.path) : ctx!.legacyPath;
    if (!basePath.startsWith(path.resolve(ctx!.legacyPath))) {
      return makeToolTextResult(JSON.stringify({ error: 'Access denied: path is outside the workspace.' }));
    }

    const manifests = [
      { file: 'package.json',     type: 'npm',    parser: parsePackageJson },
      { file: 'requirements.txt', type: 'pip',    parser: parseRequirementsTxt },
      { file: 'Pipfile',          type: 'pip',    parser: parsePipfile },
      { file: 'pom.xml',          type: 'maven',  parser: parsePomXml },
      { file: 'build.gradle',     type: 'gradle', parser: parseBuildGradle },
      { file: 'go.mod',           type: 'go',     parser: parseGoMod },
      { file: 'Cargo.toml',       type: 'cargo',  parser: parseCargoToml },
      { file: 'Gemfile',          type: 'ruby',   parser: parseGemfile },
      { file: 'composer.json',    type: 'php',    parser: parseComposerJson },
      { file: 'pyproject.toml',   type: 'pip',    parser: parsePyprojectToml },
    ];

    const extraPackageJsonFiles = await glob('**/package.json', { cwd: basePath, onlyFiles: true, ignore: ['**/node_modules/**'], dot: false });
    const results: unknown[] = [];

    for (const m of manifests) {
      const filePath = path.join(basePath, m.file);
      try {
        if (await fs.pathExists(filePath)) {
          const content = await fs.readFile(filePath, 'utf-8');
          results.push({ type: m.type, file: m.file, ...m.parser(content) });
        }
      } catch {  }
    }

    for (const relPath of extraPackageJsonFiles) {
      if (relPath === 'package.json') continue;
      try {
        const content = await fs.readFile(path.join(basePath, relPath), 'utf-8');
        results.push({ type: 'npm', file: relPath, ...parsePackageJson(content) });
      } catch {  }
    }

    if (results.length === 0) {
      return makeToolTextResult(JSON.stringify({ warning: 'No dependency manifests found.', searched: manifests.map(m => m.file) }));
    }
    return makeToolTextResult(JSON.stringify({ manifests: results, totalManifests: results.length }));
  }
};
