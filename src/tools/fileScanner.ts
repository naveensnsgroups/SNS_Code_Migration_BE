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
