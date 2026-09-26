import os
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from psycopg.rows import dict_row

from prefixes import starts_with_any

DSN = os.environ.get("DATABASE_URL", "postgresql://app:app@localhost:54394/printreg")
SECRET = os.environ.get("JWT_SECRET", "print-register-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
USERS = {
    "printer": {"role": "writer", "password_hash": pwd.hash("print123456")},
    "checker": {"role": "reader", "password_hash": pwd.hash("check123456")},
}

SEED_PREFIXES = ("封面",)


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id serial PRIMARY KEY,
    sheet text NOT NULL,
    cyan_mm double precision NOT NULL,
    magenta_mm double precision NOT NULL,
    status text NOT NULL,
    verdict text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS prefixes (
    id serial PRIMARY KEY,
    prefix text NOT NULL UNIQUE,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS prefix_audit (
    id serial PRIMARY KEY,
    action text NOT NULL,
    prefix text NOT NULL,
    operator text NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rejections (
    id serial PRIMARY KEY,
    sheet text NOT NULL,
    cyan_mm double precision NOT NULL,
    magenta_mm double precision NOT NULL,
    reason text NOT NULL,
    rejected_by text NOT NULL,
    rejected_at timestamptz NOT NULL
);
"""


class LoginIn(BaseModel):
    username: str
    password: str


class JobIn(BaseModel):
    sheet: str
    cyan_mm: float
    magenta_mm: float


class PrefixIn(BaseModel):
    prefix: str


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(credentials.credentials, SECRET, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="无效令牌") from exc
    if payload.get("sub") not in USERS:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"username": payload["sub"], "role": payload.get("role")}


def require_writer(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "writer":
        raise HTTPException(status_code=403, detail="仅印刷员可维护")
    return user


app = FastAPI(title="印刷套准复核台")


@app.on_event("startup")
def startup():
    with connect() as conn:
        conn.execute(SCHEMA)
        n = conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
        if n == 0:
            now = datetime.now(timezone.utc)
            conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, verdict, reason, created_by, created_at)
                   VALUES
                   ('封面-01', 0.05, -0.04, 'pending', '', '', 'printer', %s),
                   ('内页-09', 0.40, 0.02, 'pending', '', '', 'printer', %s)""",
                (now, now),
            )
        p = conn.execute("SELECT COUNT(*) AS n FROM prefixes").fetchone()["n"]
        if p == 0:
            now = datetime.now(timezone.utc)
            for prefix in SEED_PREFIXES:
                conn.execute(
                    "INSERT INTO prefixes (prefix, created_by, created_at) VALUES (%s, %s, %s)",
                    (prefix, "系统", now),
                )
                conn.execute(
                    "INSERT INTO prefix_audit (action, prefix, operator, created_at) VALUES ('add', %s, %s, %s)",
                    (prefix, "系统", now),
                )
        conn.commit()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "print-register-review"}


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = USERS.get(body.username.strip())
    if not user or not pwd.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode({"sub": body.username.strip(), "role": user["role"], "exp": exp}, SECRET, algorithm="HS256")
    return {"access_token": token, "username": body.username.strip(), "role": user["role"]}


@app.get("/api/jobs")
def list_jobs(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            "SELECT id, sheet, cyan_mm, magenta_mm, status, verdict, reason, created_by FROM jobs ORDER BY id DESC"
        ).fetchall()


@app.post("/api/jobs", status_code=202)
def enqueue(body: JobIn, user: dict = Depends(require_writer)):
    sheet = body.sheet.strip()
    rejected = False
    detail = ""
    now = datetime.now(timezone.utc)
    with connect() as conn:
        prefixes = [r["prefix"] for r in conn.execute("SELECT prefix FROM prefixes ORDER BY id").fetchall()]
        if starts_with_any(sheet, prefixes) is None:
            detail = f"投递名「{sheet}」不以任一合法前缀开头，已退回"
            conn.execute(
                """INSERT INTO rejections (sheet, cyan_mm, magenta_mm, reason, rejected_by, rejected_at)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (sheet, body.cyan_mm, body.magenta_mm, "投递名未命中前缀白名单", user["username"], now),
            )
            conn.commit()
            rejected = True
        else:
            row = conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, created_by, created_at)
                   VALUES (%s, %s, %s, 'pending', %s, %s)
                   RETURNING id, sheet, status, verdict""",
                (sheet, body.cyan_mm, body.magenta_mm, user["username"], now),
            ).fetchone()
            conn.commit()
    if rejected:
        raise HTTPException(status_code=422, detail=detail)
    return row


@app.get("/api/prefixes")
def list_prefixes(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            "SELECT id, prefix, created_by, created_at FROM prefixes ORDER BY id"
        ).fetchall()


@app.post("/api/prefixes", status_code=201)
def add_prefix(body: PrefixIn, user: dict = Depends(require_writer)):
    prefix = body.prefix.strip()
    if not prefix:
        raise HTTPException(status_code=422, detail="前缀不能为空")
    now = datetime.now(timezone.utc)
    with connect() as conn:
        exists = conn.execute("SELECT 1 FROM prefixes WHERE prefix = %s", (prefix,)).fetchone()
        if exists:
            raise HTTPException(status_code=409, detail="前缀已存在")
        conn.execute(
            "INSERT INTO prefixes (prefix, created_by, created_at) VALUES (%s, %s, %s)",
            (prefix, user["username"], now),
        )
        conn.execute(
            "INSERT INTO prefix_audit (action, prefix, operator, created_at) VALUES ('add', %s, %s, %s)",
            (prefix, user["username"], now),
        )
        conn.commit()
    return {"prefix": prefix}


@app.delete("/api/prefixes/{prefix}", status_code=204)
def remove_prefix(prefix: str, user: dict = Depends(require_writer)):
    now = datetime.now(timezone.utc)
    with connect() as conn:
        row = conn.execute("DELETE FROM prefixes WHERE prefix = %s RETURNING id", (prefix,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="前缀不存在")
        conn.execute(
            "INSERT INTO prefix_audit (action, prefix, operator, created_at) VALUES ('remove', %s, %s, %s)",
            (prefix, user["username"], now),
        )
        conn.commit()


@app.get("/api/prefixes/audit")
def prefix_audit(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            "SELECT id, action, prefix, operator, created_at FROM prefix_audit ORDER BY id DESC"
        ).fetchall()


@app.get("/api/rejections/today")
def rejections_today(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            """SELECT id, sheet, cyan_mm, magenta_mm, reason, rejected_by, rejected_at
               FROM rejections
               WHERE rejected_at::date = CURRENT_DATE
               ORDER BY id DESC"""
        ).fetchall()
