---
name: migration-rules
description: Core transformation rules for migrating legacy codebases to modern frameworks. Covers structural mapping, API layer transformation, and dependency substitution.
---

# Migration Rules Skill

## Purpose
Provides the migration writer agent with definitive rules for transforming legacy source code into modern equivalents without breaking business logic.

## General Transformation Rules

1. **Preserve business logic exactly** — Never change what the code does, only how it's expressed
2. **One-to-one file mapping** — Each legacy file maps to exactly one modern output file
3. **Dependency substitution** — Replace legacy deps with modern equivalents listed in target stack
4. **No dead imports** — Every import must be used in the output file
5. **Error handling** — Preserve all try/catch blocks; upgrade to async/await where applicable

## Framework Mapping

### Express → NestJS
- `app.get(path, handler)` → `@Get(path)` decorator on controller method
- `req.body` → `@Body()` parameter decorator
- `req.params` → `@Param()` parameter decorator
- `middleware` → `@Injectable()` guard or interceptor
- `module.exports` → `export class`

### Flask → FastAPI
- `@app.route(path)` → `@router.get(path)` / `@router.post(path)`
- `request.json` → Pydantic model parameter
- `jsonify(data)` → return dict directly
- `Flask-SQLAlchemy` → SQLAlchemy async or Tortoise ORM

## Database Migration Rules

### Sequelize → TypeORM
- Model class → `@Entity()` decorated class
- `DataTypes.STRING` → `@Column({ type: 'varchar' })`
- `Model.findAll()` → `repository.find()`
- `Model.create()` → `repository.save(new Entity(data))`

## Output Quality Checklist
- [ ] All imports resolve
- [ ] All types are explicit (no `any` in TypeScript output)
- [ ] All async functions use `async/await` (no raw Promise chains)
- [ ] Controller methods return typed responses
- [ ] No commented-out code from legacy remains
