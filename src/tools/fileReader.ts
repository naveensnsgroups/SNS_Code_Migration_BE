import fs from 'fs-extra';
import path from 'path';

/**
 * Safely reads the content of a file within a session directory
 */
export async function readSessionFile(sessionPath: string, relativePath: string): Promise<string> {
  const absolutePath = path.resolve(sessionPath, relativePath);
  
  // Security guard: prevent directory traversal
  if (!absolutePath.startsWith(path.resolve(sessionPath))) {
    throw new Error('Access denied: path is outside the project directory');
  }

  if (!(await fs.pathExists(absolutePath))) {
    throw new Error(`File not found: ${relativePath}`);
  }

  return fs.readFile(absolutePath, 'utf-8');
}
