import { Router, Request, Response, NextFunction } from 'express';
import { ShellExecutor } from '../tools/shellExecutor.js';

const router = Router();

router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    
    let gitStatus = 'disconnected';
    let gitVersion = 'not installed';
    try {
      const result = await ShellExecutor.execute('mcp-status-check', 'git --version', {
        cwd: process.cwd(),
        timeoutMs: 3000,
      });
      if (result.code === 0 && result.stdout) {
        gitStatus = 'connected';
        gitVersion = result.stdout.trim().split('\n')[0];
      }
    } catch {
      gitStatus = 'disconnected';
    }

    const servers = [
      {
        id: 'filesystem-local',
        name: 'Filesystem (Local)',
        status: 'connected',
        description: 'Direct filesystem access via backend tool registry.',
        tools: [
          'getFileContent', 'getWorkspaceFileList', 'getWorkspaceDirectoryStructure',
          'searchInWorkspace', 'findFilesByPattern', 'write_file', 'write-migration-files',
          'extractFileSymbols', 'scanAssetFiles', 'copyStaticAssets', 'compareFiles',
          'batch-read-files',
        ],
        version: `Node.js ${process.version}`,
        latencyMs: 0,
      },
      {
        id: 'git-connector',
        name: 'Git Connector',
        status: gitStatus,
        description: 'Git log, churn analysis, and dead code detection.',
        tools: ['getGitLog'],
        version: gitVersion,
        latencyMs: null,
      },
      {
        id: 'shell-executor',
        name: 'Shell Executor',
        status: 'connected',
        description: 'Captured shell command execution for builds, tests, and linting.',
        tools: ['run_command', 'capturedShellExecute', 'getEnvironmentInfo'],
        version: process.platform,
        latencyMs: 0,
      },
      {
        id: 'task-context-memory',
        name: 'Task Context Memory',
        status: 'connected',
        description: 'Persistent session memory for agent checkpointing and resume.',
        tools: ['get_task_context', 'edit_task_context', 'compress-migration-context'],
        version: '1.0',
        latencyMs: 0,
      },
      {
        id: 'chrome-devtools',
        name: 'Chrome DevTools',
        status: 'disconnected',
        description: 'Browser DevTools protocol (not available in backend mode).',
        tools: [],
        version: null,
        latencyMs: null,
      },
    ];

    res.json({
      servers,
      totalConnected: servers.filter(s => s.status === 'connected').length,
      totalDisconnected: servers.filter(s => s.status === 'disconnected').length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
