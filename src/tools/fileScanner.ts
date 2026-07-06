import glob from 'fast-glob';
import path from 'path';
import { FileNode } from '../types.js';

export async function scanProjectDirectory(dirPath: string): Promise<{ fileTree: FileNode[]; fileList: string[] }> {
  
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

const SOURCE_EXCLUDE_SUFFIXES: string[] = [
  '.d.ts',    
  '.map',     
  '.min.js',  
  '.min.css', 
  '.pyc',     
  '.class',   
  '.o',       
  '.obj',     
  '.a',       
  '.lib',     
  '.so',      
  '.dll',     
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
  'go.sum',         
]);

const SOURCE_EXCLUDE_DIR_SEGMENTS: string[] = [
  '/vendor/',       
  '/__pycache__/',  
  '/venv/',         
  '/.venv/',        
  '/target/',       
  '/.gradle/',      
  '/.m2/',          
  '/coverage/',     
  '/.nyc_output/',  
  '/bin/',          
  '/obj/',          
  '/_build/',       
  '/deps/',         
  '/.dart_tool/',   
  '/.build/',       
];

export function computeFilteredFileCount(fileList: string[]): number {
  return fileList.filter(filePath => {
    const normalized     = filePath.replace(/\\/g, '/');
    const basename       = normalized.split('/').pop() ?? '';
    const lower          = normalized.toLowerCase();
    const withBoundaries = `/${normalized}/`;

    
    if (SOURCE_EXCLUDE_FILENAMES.has(basename)) return false;

    
    for (const suffix of SOURCE_EXCLUDE_SUFFIXES) {
      if (lower.endsWith(suffix)) return false;
    }

    
    for (const segment of SOURCE_EXCLUDE_DIR_SEGMENTS) {
      if (withBoundaries.includes(segment)) return false;
    }

    return true;
  }).length;
}

type ManifestPattern = string | RegExp;

const MANIFEST_PATTERNS: ManifestPattern[] = [
  
  'package.json',

  
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Pipfile',
  'setup.cfg',

  
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',

  
  'go.mod',

  
  'Cargo.toml',

  
  'composer.json',

  
  'Gemfile',

  
  /\.csproj$/,
  /\.sln$/,
  /\.fsproj$/,
  /\.vbproj$/,

  
  'mix.exs',

  
  'pubspec.yaml',

  
  'build.sbt',

  
  'project.clj',
  'deps.edn',

  
  /\.cabal$/,
  'stack.yaml',

  
  'Package.swift',

  
  'CMakeLists.txt',
  'conanfile.txt',
  'vcpkg.json',

  
  'Project.toml',

  
  'deno.json',
  'deno.jsonc',
  'bunfig.toml',

  
  'build.zig',

  
  /\.nimble$/,

  
  'shard.yml',

  
  'rebar.config',
  'rebar3.config',

  
  'DESCRIPTION',

  
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  /\.tf$/,              

  
  
  
  'settings.py',              
  'application.properties',   
  'application.yml',          
  'application.yaml',         
  /^config\/database\.yml$/,  
  '.env',                     
  '.env.example',             
];

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

    
    if (depth > 3) continue;

    
    if (MANIFEST_EXCLUDE_NAMES.has(basename)) continue;

    
    for (const pattern of MANIFEST_PATTERNS) {
      const matched = typeof pattern === 'string'
        ? basename === pattern
        : pattern.test(basename);

      if (matched) {
        found.push(normalized);
        break; 
      }
    }
  }

  return found;
}
