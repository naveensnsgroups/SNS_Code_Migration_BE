

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs-extra';
import path from 'path';
import { ALL_AGENT_DEFINITIONS } from '../agents/core/agent-definitions.js';
import { toolRegistry } from '../core/tool-invocation-registry.js';
import { listAllSkills } from '../knowledge/framework-skills/registry.js';

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

// These read from src/knowledge/framework-skills/<name>/skill.md — the
// curated, per-target-framework conventions the Migration Planner and Code
// Generator actually inject into their prompts (see resolveFrameworkSkill).
// Not agent-tool-invoked, not a generic free-form rules file: each skill is
// resolved deterministically by matching the session's target framework.
router.get('/skills', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const allSkills = await listAllSkills();
    const skills = await Promise.all(allSkills.map(async skill => {
      const id   = path.basename(path.dirname(skill.sourceFile));
      const stat = await fs.stat(skill.sourceFile);
      return {
        id,
        name:        skill.frameworkNames[0],
        description: `Curated ${skill.language} conventions for ${skill.frameworkNames[0]} — folder layout, ` +
                      `router/DI/async patterns, and ${skill.scaffolding.length} required scaffolding file(s).`,
        path:        `src/knowledge/framework-skills/${id}/skill.md`,
        sizeBytes:   stat.size,
      };
    }));
    res.json({ skills, total: skills.length, timestamp: new Date().toISOString() });
  } catch (err) { next(err); }
});

router.get('/skill-content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const skillId = ((req.query['id'] as string) || '').replace(/[^a-z0-9-]/g, '');
    if (!skillId) return res.status(400).json({ error: 'id query param required' });

    const allSkills = await listAllSkills();
    const match = allSkills.find(s => path.basename(path.dirname(s.sourceFile)) === skillId);
    if (!match) {
      return res.status(404).json({ error: `Skill "${skillId}" not found` });
    }
    const content = await fs.readFile(match.sourceFile, 'utf-8');
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
