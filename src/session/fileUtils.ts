import fs from 'fs-extra';
import path from 'path';

export async function writeJsonAtomic(filePath: string, data: any, options: { spaces?: number } = { spaces: 2 }): Promise<void> {
  const tempPath = `${filePath}.tmp-${Math.random().toString(36).substring(2, 8)}`;
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(tempPath, data, options);

  let attempts = 5;
  while (attempts > 0) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (err) {
      attempts--;
      if (attempts === 0) {
        try {
          await fs.unlink(tempPath);
        } catch (unlinkErr) {
          
        }
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function readJsonWithRetry<T>(filePath: string): Promise<T> {
  let attempts = 5;
  while (attempts > 0) {
    try {
      return await fs.readJson(filePath) as T;
    } catch (err) {
      attempts--;
      if (attempts === 0) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Failed to read JSON file at ${filePath} after multiple attempts`);
}
