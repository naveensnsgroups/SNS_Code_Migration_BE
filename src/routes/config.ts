

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { ALL_AGENT_DEFINITIONS } from '../agents/core/agent-definitions.js';
import { toolRegistry } from '../core/tool-invocation-registry.js';

const router = Router();

router.get('/agents', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const agents = ALL_AGENT_DEFINITIONS.map(agent => ({
      id:          agent.id,
      name:        agent.name,
      description: agent.description,
      tags:        agent.tags ?? [],
      functions:   agent.functions,
      variables:   (agent.agentSpecificVariables ?? []).map(v => ({
        name: v.name,
        desc: v.description,
      })),
      prompts: (agent.prompts ?? []).map(p => ({
        id:      p.id,
        variant: p.defaultVariant?.id ?? '',
        label:   p.defaultVariant?.label ?? '',
      })),
      languageModelRequirements: (agent.languageModelRequirements ?? []).map(r => ({
        purpose:    r.purpose,
        identifier: r.identifier,
      })),
    }));
    res.json({ agents, total: agents.length, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

router.get('/tools', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tools = toolRegistry.getAllFunctions().map(tool => ({
      id:          tool.id,
      name:        tool.name,
      description: tool.description,
      parameters:  tool.parameters,
    }));
    res.json({ tools, total: tools.length, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

router.get('/skills', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const skillsDir = path.join(process.cwd(), 'skills');
    const skills: { id: string; name: string; description: string; path: string; sizeBytes: number }[] = [];

    if (await fs.pathExists(skillsDir)) {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        if (!(await fs.pathExists(skillFile))) continue;

        const content = await fs.readFile(skillFile, 'utf-8');
        const stat    = await fs.stat(skillFile);

        
        let skillName   = entry.name;
        let description = '';
        const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          if (nameMatch) skillName   = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();
        }

        skills.push({
          id:          entry.name,
          name:        skillName,
          description,
          path:        `skills/${entry.name}/SKILL.md`,
          sizeBytes:   stat.size,
        });
      }
    }
    res.json({ skills, total: skills.length, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

router.get('/skill-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillId = ((req.query['id'] as string) || '').replace(/[^a-z0-9-]/g, '');
    if (!skillId) return res.status(400).json({ error: 'id query param required' });

    const skillFile = path.join(process.cwd(), 'skills', skillId, 'SKILL.md');
    if (!(await fs.pathExists(skillFile))) {
      return res.status(404).json({ error: `Skill "${skillId}" not found` });
    }
    const content = await fs.readFile(skillFile, 'utf-8');
    return res.json({ id: skillId, content, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

import { SessionManager } from '../session/sessionManager.js';

router.get('/sessions', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await SessionManager.listSessions();
    const summary = sessions
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 20) 
      .map(s => ({
        sessionId:  s.sessionId,
        status:     s.status,
        startedAt:  s.startedAt,
        detectedStack: s.detectedStack ? {
          language:  s.detectedStack.language,
          framework: s.detectedStack.framework,
          fileCount: s.detectedStack.fileCount,
        } : undefined,
      }));
    res.json({ sessions: summary });
  } catch (err) { next(err); }
});

export default router;
