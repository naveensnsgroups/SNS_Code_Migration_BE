import fs from 'fs-extra';
import path from 'path';

export async function writeSessionFile(sessionPath: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.resolve(sessionPath, relativePath);

  
  if (!absolutePath.startsWith(path.resolve(sessionPath))) {
    throw new Error('Access denied: path is outside the project directory');
  }

  await fs.ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, content, 'utf-8');
}
