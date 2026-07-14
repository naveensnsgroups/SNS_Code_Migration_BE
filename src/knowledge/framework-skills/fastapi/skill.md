---
framework: fastapi
aliases: [fastapi, fast api, fast-api]
language: python
version: 1
---

# FastAPI Target Framework Skill

## Folder Layout
POLICY (settled, do not re-litigate per edit): this skill targets the official
FastAPI documentation at fastapi.tiangolo.com — specifically the "Bigger
Applications - Multiple Files" tutorial — for routers/, dependencies.py, and
the entry point. It deliberately does NOT follow FastAPI's separate production
template repo (`fastapi/full-stack-fastapi-template`), which uses a different,
more layered structure (`app/core/db.py`, `app/api/routes/`, `app/api/deps.py`,
and a `crud.py` data-access layer). That template was evaluated and rejected:
its `crud.py` layer needs a database session/model file (`models.py`) to exist
BEFORE it, while routers need to import FROM `crud.py` — a three-tier ordering
(models -> crud -> routers) this pipeline's scaffolding system cannot express
(it only supports two tiers: 'first', before every real file, and 'last', after
every real file). Adopting `crud.py` would need an orchestration-code change,
not a doc change, so it was deferred rather than half-implemented.
The one exception is `app/models.py`: kept as ONE flat file (see below) because
that's a pragmatic necessity for this pipeline (one target path per legacy
entity/schema file), not a tutorial requirement — the tiangolo.com docs don't
prescribe a multi-file DB layout at all.
- Entry point: `app/main.py` — the ONLY file that creates a `FastAPI()` instance.
- Routers: `app/routers/<module>.py` — one file per logical resource/domain (e.g. `auth.py`, `tasks.py`).
- Pydantic request/response models: `app/schemas/<module>.py` (if a router's request/response
  models grow beyond 2-3 classes, split them out here instead of inlining in the router file).
- SQLAlchemy ORM models (SQL target databases only — PostgreSQL/MySQL/SQLite): ONE flat file,
  `app/models.py` — every table's model class in this single file, each subclassing the `Base`
  exported from `app/db.py`. Do NOT create an `app/models/` directory or split models across
  multiple files (see POLICY note above for why one file). A document database (MongoDB) has no ORM
  models — skip this file entirely for a Mongo target.
- Shared DB/session access: `app/db.py`.
- Shared cross-cutting dependencies (auth/session checks used by multiple routers): `app/dependencies.py`.
- Dependency manifest: `pyproject.toml` (project root) — target Python >=3.12, matching the
  verification sandbox image.
- Every package directory (`app/`, `app/routers/`, `app/schemas/`, and any other subpackage
  actually created) needs an `__init__.py` file — it can be empty, but FastAPI's own official
  project structure includes one in every package directory, and omitting it can break
  imports depending on how the project is run.

## Router Pattern
Every route file MUST:
- Use `router = APIRouter()` at module level — NEVER instantiate a second `FastAPI()`
  anywhere outside `app/main.py`. This is a hard rule, not a suggestion: only one
  `FastAPI()` instance may exist in the entire generated project.
- Use `@router.get(...)`, `@router.post(...)`, etc. — never `@app.get(...)` outside main.py.
- Group related endpoints for one resource/domain in one router file (e.g. all task
  CRUD endpoints in `tasks.py`, not split across multiple files).
- The router's `prefix` MUST match the legacy app's actual mount path for that
  resource, NOT a "nicer" idiomatic rename. If the legacy entrypoint mounted a
  router as `app.use("/api/user", userRouter)`, the FastAPI equivalent MUST be
  `APIRouter(prefix="/api/user")` — exactly that path, same casing, same segments.
  Changing a live API's URL contract during a migration breaks every existing
  client (frontend, mobile app, external integration) that calls the old paths —
  this is a business-logic-preservation failure, not a style choice. Only invent
  a prefix from scratch if the legacy code genuinely never declared a mount path.
- Request bodies MUST be typed Pydantic models (`class X(BaseModel): ...`), not raw
  dict parsing from `request.body()` — accept a typed parameter directly in the route
  function signature and let FastAPI validate/parse it.
- Errors MUST be raised as `HTTPException(status_code=..., detail=...)` with an
  appropriate status code (401 for auth failures, 404 for not found, 400 for bad
  input, 409 for conflicts) — never a bare `{"success": false}` response with a 200
  status for an actual error condition.

## Dependency Injection Pattern
- Database access MUST go through FastAPI's dependency injection — declare it as a
  parameter default in the route function signature: `db = Depends(get_db)`.
  NEVER call `get_db()` directly inside a function body as a plain function call.
- Any shared cross-cutting check used by multiple routers (e.g. "resolve the current
  user from a session token") belongs in `app/dependencies.py` as its own
  `Depends()`-compatible function, imported and reused — not duplicated per router file.
- If a route types its auth dependency's result as a real model (e.g.
  `current_user: User = Depends(get_current_user)`), that dependency MUST actually
  fetch and return the real `User` record from the database — decoding a JWT and
  returning the raw token payload is NOT sufficient, even though Python won't raise
  a type error for it. The legacy middleware this replaces almost always attached
  the full user record (e.g. Express's `req.user`), not just the token claims.
- `db.py`'s connection accessor is the single source of truth for how every other
  file talks to the database — no router file may open its own separate connection.
- HOW to write the actual database queries — this prevents two runtime bug classes
  that hand-written raw SQL keeps producing:
  - For a SQL target database (PostgreSQL/MySQL/SQLite): define SQLAlchemy ORM model
    classes in the single flat `app/models.py` (each subclassing the `Base` from `app/db.py`,
    one class per table, declaring every column ONCE) and query THROUGH those models
    (e.g. `select(Task).where(Task.user_id == uid)`), not by hand-writing raw SQL
    strings. Prefer this — it is idiomatic and structurally prevents both bug classes
    below.
  - BUG CLASS 1 — SQL dialect mismatch: raw SQL routinely carries the SOURCE (legacy)
    database's dialect into target code where it does not exist. The legacy DB's
    functions are NOT the target's. Real example: MySQL's `DATE_FORMAT(col, '%Y-%m-%d')`
    does not exist in PostgreSQL — the PostgreSQL equivalent is `TO_CHAR(col, 'YYYY-MM-DD')`.
    Likewise MySQL `AUTO_INCREMENT` vs Postgres `SERIAL`/`GENERATED`, backtick quoting
    vs double-quote quoting, etc. Querying through the ORM avoids this entirely (it
    emits the correct dialect for the configured engine). If you MUST write raw
    `text(...)` SQL, every function and keyword MUST be the TARGET database's dialect
    (the target database is named in the TARGET STACK section of your prompt), never
    the legacy one's.
  - BUG CLASS 2 — column-name mismatch: hand-written SQL routinely references a column
    that does not match the schema — e.g. `INSERT ... RETURNING id` when the table's
    primary key is actually named `task_id`. Referencing `Model.column_name` on an ORM
    model makes a wrong name an import-time `AttributeError` instead of a silent runtime
    SQL failure. Whether you use the ORM or raw SQL, every column name referenced MUST
    exactly match the column names defined in this project's own schema (the ORM models
    and/or the generated `schema.sql`) — do not invent or abbreviate a column name.
  - For a document target database (MongoDB): there is no ORM and no SQL — use the async
    driver (`motor`) with dict documents and its query operators directly.
- Per-route/per-request checks (auth, validation) use `Depends()` as above. GLOBAL,
  app-wide cross-cutting concerns the legacy app registered once for every request
  (CORS, gzip compression, trusted-host checks, global request logging — e.g.
  Express's `app.use(cors())`) are a DIFFERENT mechanism: FastAPI's
  `app.add_middleware(...)`, registered once in `app/main.py`. Do not migrate a
  global middleware into a per-route `Depends()` — it belongs in the entrypoint.

## Async Conventions
- If a dependency's function is declared `async def`, every caller MUST `await` it —
  never assign its return value directly (`db = get_db()` when `get_db` is `async def`
  is a hard bug: `db` becomes an un-awaited coroutine object, not the actual value).
- Route handlers that call any `async def` function (including `Depends()`-injected
  ones, and especially any database driver call) MUST themselves be declared `async def`.
- Prefer an async-native database driver matched to the target database (e.g. `motor`
  for MongoDB, `asyncpg`/SQLAlchemy async engine for Postgres) — do not mix a sync
  driver into an otherwise-async FastAPI app.

## Required Scaffolding

### dependency-manifest (order: first)
Target: `pyproject.toml`
Purpose: Declares every third-party package this generated project needs so the sandbox can install them in one step.
Brief: >
  Generate a pyproject.toml declaring project metadata and dependencies using the
  PEP 621 [project] table. Pin Python to >=3.12. List every third-party package
  actually imported anywhere in the generated project (e.g. fastapi, uvicorn,
  motor, pydantic) with a reasonable minimum version constraint — do not pin exact
  versions unless a specific version is required for compatibility. Declare the
  EXACT package that provides the import name actually used elsewhere in this
  project, never a different library with a similar purpose but a different API
  (e.g. if other files do `import bcrypt`, declare `bcrypt`, not `passlib`; if they
  do `import jwt`, declare `pyjwt`, not `python-jose` — those are different
  packages with different call signatures, and installing the wrong one means the
  real import fails even though the dependency "looks" covered). This file is the
  single source of truth for what needs to be installed; the verification sandbox
  runs `uv sync` against it.

### env-file (order: first)
Target: `.env`
Purpose: Real local-dev environment values matching what db-connection's get_db actually reads via os.getenv.
Brief: >
  Generate a .env file with real key=value pairs for every environment variable
  app/db.py's get_db function actually calls os.getenv(...) for (e.g. DATABASE_URL,
  or MONGO_URI for a Mongo target). Values must be realistic local-dev defaults
  matching the target database — e.g.
  DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/app for
  PostgreSQL, mysql+aiomysql://root:root@localhost:3306/app for MySQL, or
  mongodb://localhost:27017/app for MongoDB — never a placeholder like
  "changeme" or "TODO". This file must exist so the same values db.py expects
  at runtime are actually available wherever this project is run, including the
  verification sandbox.

### db-connection (order: first)
Target: `app/db.py`
Purpose: Shared, real database connection/session module every other file depends on.
Brief: >
  Generate a real, idiomatic ASYNC connection/session accessor for the configured
  database (e.g. motor.motor_asyncio.AsyncIOMotorClient for MongoDB, an async
  SQLAlchemy engine for a SQL database). Call python-dotenv's load_dotenv() at the
  top of this file BEFORE reading any environment variable, so the real values in
  the generated .env file are actually loaded — without this call, .env's values
  are invisible to os.getenv() outside an environment that injects them some other
  way. Export the connection accessor as a Depends()-compatible function named
  get_db, declared async def. Read connection details from environment variables
  with sensible local-dev defaults, never hardcoded values. This file must contain
  real, complete, working code — not a stub.

### entrypoint (order: last)
Target: `app/main.py`
Purpose: The single FastAPI() app instance that mounts every generated router.
Brief: >
  Generate app/main.py. Create exactly ONE FastAPI() instance here — no other file
  in this project may create a second one. Import every router module already
  generated in this project using the EXACT paths listed under ALREADY-GENERATED
  DEPENDENCIES below — never guess a path from the legacy file's own name or from
  a generic convention, always use the real path given. Mount each one with
  app.include_router(<module>.router). If any router declared its own prefix, do
  not duplicate it here. If the legacy entrypoint registered any GLOBAL middleware
  (e.g. Express's app.use(cors()), a logging middleware, a compression middleware),
  migrate it here too via app.add_middleware(...) with equivalent configuration
  (e.g. FastAPI's CORSMiddleware from fastapi.middleware.cors, with the same
  allowed origins/methods the legacy app used) — dropping global middleware
  silently breaks real clients (e.g. a browser frontend blocked by missing CORS
  headers) exactly as much as dropping a route would. This app is started with
  `uvicorn app.main:app` — expose the ASGI app as the module-level name `app`.
  Keep this file focused on app assembly only — no route logic belongs here.
