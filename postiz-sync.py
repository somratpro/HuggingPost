#!/usr/bin/env python3
"""
HuggingPost backup/restore — Postgres dump + uploads dir + secrets → HF Dataset.

Usage:
    python3 postiz-sync.py sync     # backup → HF Dataset
    python3 postiz-sync.py restore  # HF Dataset → restore DB + uploads + secrets

Adapted from HuggingClip/paperclip-sync.py with three differences:
  1. DB user is `postiz` (not `postgres`) — pg_dump is run as the postiz role.
  2. Tarball includes /postiz/uploads (Postiz media) AND /postiz/.secrets
     (jwt secret + db password) so a fresh container can recover identity.
  3. Restore drops + recreates the postiz database before psql replay so we
     don't get "database already exists" / duplicate-key errors.
"""

import os
import sys
import json
import shutil
import tarfile
import tempfile
import subprocess
import logging
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore", category=UserWarning, module="huggingface_hub")

from huggingface_hub import HfApi
from huggingface_hub.utils import RepositoryNotFoundError, EntryNotFoundError
import huggingface_hub

huggingface_hub.utils.disable_progress_bars()

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.WARNING, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.WARNING)

# ── Config ───────────────────────────────────────────────────────────────────
HF_TOKEN = os.environ.get("HF_TOKEN")
HF_USERNAME = os.environ.get("HF_USERNAME")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postiz:postiz@localhost:5432/postiz")
BACKUP_DATASET_NAME = os.environ.get("BACKUP_DATASET_NAME", "huggingpost-backup")
SYNC_MAX_FILE_BYTES = int(os.environ.get("SYNC_MAX_FILE_BYTES", str(100 * 1024 * 1024)))  # 100 MB
POSTIZ_HOME = Path(os.environ.get("POSTIZ_HOME", "/postiz"))
UPLOADS_DIR = Path(os.environ.get("UPLOAD_DIRECTORY", str(POSTIZ_HOME / "uploads")))
SECRETS_DIR = POSTIZ_HOME / ".secrets"
STATUS_FILE = Path("/tmp/sync-status.json")


# ── Helpers ──────────────────────────────────────────────────────────────────
def parse_db_url(db_url: str) -> dict:
    try:
        s = db_url.replace("postgres://", "").replace("postgresql://", "")
        if "@" in s:
            creds, host_db = s.split("@", 1)
            if ":" in creds:
                user, password = creds.split(":", 1)
            else:
                user, password = creds, ""
        else:
            user, password, host_db = "postgres", "", s
        if "/" in host_db:
            host_port, database = host_db.rsplit("/", 1)
        else:
            host_port, database = host_db, "postiz"
        if ":" in host_port:
            host, port = host_port.rsplit(":", 1)
        else:
            host, port = host_port, "5432"
        return {"user": user, "password": password, "host": host, "port": port, "database": database}
    except Exception as e:
        logger.error(f"Failed to parse DATABASE_URL: {e}")
        return None


def write_status(status: dict):
    try:
        STATUS_FILE.write_text(json.dumps(status, indent=2))
    except Exception as e:
        logger.error(f"Failed to write status file: {e}")


def read_status() -> dict:
    if STATUS_FILE.exists():
        try:
            return json.loads(STATUS_FILE.read_text())
        except Exception:
            pass
    return {"db_status": "unknown", "last_sync_time": None, "last_error": None, "sync_count": 0}


def env_with_password(db: dict) -> dict:
    env = os.environ.copy()
    if db["password"]:
        env["PGPASSWORD"] = db["password"]
    return env


# ── Backup ───────────────────────────────────────────────────────────────────
def backup_database() -> tuple[str | None, bool]:
    db = parse_db_url(DATABASE_URL)
    if not db:
        return None, False

    temp_dir = tempfile.mkdtemp()
    dump_file = Path(temp_dir) / "postiz.sql"

    cmd = [
        "pg_dump",
        f"--host={db['host']}",
        f"--port={db['port']}",
        f"--username={db['user']}",
        "--format=plain",
        "--no-owner",
        "--no-privileges",
        "--clean",         # emit DROP statements so restore is idempotent
        "--if-exists",
        db["database"],
    ]

    try:
        with open(dump_file, "w") as f:
            result = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE, env=env_with_password(db), timeout=600)
        if result.returncode != 0:
            logger.error(f"pg_dump failed: {result.stderr.decode('utf-8', errors='ignore')}")
            return None, False
        size_mb = dump_file.stat().st_size / 1024 / 1024
        logger.debug(f"Database dumped ({size_mb:.2f} MB)")
        return str(dump_file), True
    except subprocess.TimeoutExpired:
        logger.error("pg_dump timed out (>600s)")
        return None, False
    except Exception as e:
        logger.error(f"Database backup error: {e}")
        return None, False


def create_backup_tarball(dump_file: str) -> tuple[str | None, bool]:
    temp_dir = tempfile.mkdtemp()
    tarball = Path(temp_dir) / "huggingpost-backup.tar.gz"
    try:
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(dump_file, arcname="postiz.sql")
            if UPLOADS_DIR.exists():
                tar.add(str(UPLOADS_DIR), arcname="uploads")
            if SECRETS_DIR.exists():
                tar.add(str(SECRETS_DIR), arcname=".secrets")
        size = tarball.stat().st_size
        size_mb = size / 1024 / 1024
        logger.debug(f"Tarball created ({size_mb:.2f} MB)")
        if size > SYNC_MAX_FILE_BYTES:
            logger.error(
                f"Backup too large: {size_mb:.0f} MB > {SYNC_MAX_FILE_BYTES/1024/1024:.0f} MB. "
                "Move uploads to Cloudflare R2 (set STORAGE_PROVIDER=cloudflare) "
                "or raise SYNC_MAX_FILE_BYTES."
            )
            return None, False
        return str(tarball), True
    except Exception as e:
        logger.error(f"Failed to create tarball: {e}")
        return None, False


def upload_to_hf(backup_file: str) -> bool:
    if not HF_TOKEN:
        logger.warning("HF_TOKEN not set — skipping upload")
        return False
    try:
        api = HfApi(token=HF_TOKEN)
        username = HF_USERNAME or api.whoami().get("name")
        if not username:
            logger.error("Failed to resolve HF username")
            return False
        dataset_id = f"{username}/{BACKUP_DATASET_NAME}"
        api.create_repo(repo_id=dataset_id, repo_type="dataset", private=True, exist_ok=True)
        api.upload_file(
            path_or_fileobj=backup_file,
            path_in_repo="snapshots/latest.tar.gz",
            repo_id=dataset_id,
            repo_type="dataset",
            commit_message=f"Backup at {datetime.now(timezone.utc).isoformat()}",
        )
        logger.debug(f"Uploaded to {dataset_id}")
        return True
    except Exception as e:
        logger.error(f"HF upload failed: {e}")
        return False


# ── Restore ──────────────────────────────────────────────────────────────────
def restore_database(sql_file: str) -> bool:
    db = parse_db_url(DATABASE_URL)
    if not db:
        return False

    # Drop+recreate the postiz database as the OS postgres superuser. This
    # bypasses connection-busy errors and gives us a clean slate to replay
    # the dump into. The dump itself was taken with --clean --if-exists so
    # it's also idempotent if we ever skip the recreate.
    try:
        recreate = (
            f"DROP DATABASE IF EXISTS {db['database']} WITH (FORCE); "
            f"CREATE DATABASE {db['database']} OWNER {db['user']};"
        )
        subprocess.run(
            ["su", "-", "postgres", "-c", f"psql -c \"{recreate}\""],
            check=False, capture_output=True, timeout=60,
        )
    except Exception as e:
        logger.warning(f"DB recreate via su postgres failed (continuing): {e}")

    cmd = [
        "psql",
        f"--host={db['host']}",
        f"--port={db['port']}",
        f"--username={db['user']}",
        "--no-password",
        "--single-transaction",
        db["database"],
    ]

    try:
        with open(sql_file, "r") as f:
            result = subprocess.run(
                cmd, stdin=f, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                env=env_with_password(db), timeout=600,
            )
        if result.returncode != 0:
            logger.error(f"psql restore failed: {result.stderr.decode('utf-8', errors='ignore')[:2000]}")
            return False
        return True
    except subprocess.TimeoutExpired:
        logger.error("psql restore timed out (>600s)")
        return False
    except Exception as e:
        logger.error(f"Database restore error: {e}")
        return False


def download_and_restore() -> bool | None:
    if not HF_TOKEN:
        logger.warning("HF_TOKEN not set — skipping restore")
        return False
    try:
        api = HfApi(token=HF_TOKEN)
        username = HF_USERNAME or api.whoami().get("name")
        if not username:
            return False
        dataset_id = f"{username}/{BACKUP_DATASET_NAME}"
        temp_dir = tempfile.mkdtemp()
        try:
            snapshot = api.hf_hub_download(
                repo_id=dataset_id, repo_type="dataset",
                filename="snapshots/latest.tar.gz", local_dir=temp_dir,
                local_dir_use_symlinks=False,
            )
        except (RepositoryNotFoundError, EntryNotFoundError):
            logger.info(f"No backup yet in {dataset_id} — fresh instance")
            return None

        with tarfile.open(snapshot, "r:gz") as tar:
            tar.extractall(temp_dir, filter="data")

        sql = Path(temp_dir) / "postiz.sql"
        if not sql.exists():
            logger.error("postiz.sql not found in backup tarball")
            return False

        # Restore secrets FIRST so DB password matches what's about to be
        # used during the restore (otherwise psql auth fails).
        secrets_src = Path(temp_dir) / ".secrets"
        if secrets_src.exists():
            SECRETS_DIR.mkdir(parents=True, exist_ok=True)
            for item in secrets_src.iterdir():
                target = SECRETS_DIR / item.name
                try:
                    if target.exists():
                        target.unlink()
                    shutil.copy2(item, target)
                    target.chmod(0o600)
                except Exception as e:
                    logger.warning(f"Failed to restore secret {item.name}: {e}")

        # Restore uploads
        uploads_src = Path(temp_dir) / "uploads"
        if uploads_src.exists():
            UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
            for item in uploads_src.iterdir():
                target = UPLOADS_DIR / item.name
                try:
                    if target.exists():
                        if target.is_dir():
                            shutil.rmtree(target)
                        else:
                            target.unlink()
                    if item.is_dir():
                        shutil.copytree(item, target)
                    else:
                        shutil.copy2(item, target)
                except Exception as e:
                    logger.warning(f"Failed to restore upload {item.name}: {e}")

        return restore_database(str(sql))
    except Exception as e:
        logger.error(f"Restore from HF failed: {e}")
        return False


# ── Public CLI ───────────────────────────────────────────────────────────────
def cmd_sync() -> bool:
    logger.info("Syncing backup to HF Dataset...")
    status = read_status()
    try:
        dump, ok = backup_database()
        if not ok:
            status.update({"last_error": "pg_dump failed", "db_status": "error"})
            write_status(status); return False
        tarball, ok = create_backup_tarball(dump)
        if not ok:
            status.update({"last_error": "tarball creation failed", "db_status": "error"})
            write_status(status); return False
        ok = upload_to_hf(tarball)
        status["last_sync_time"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        status["db_status"] = "connected" if ok else "error"
        status["last_error"] = None if ok else "Upload failed"
        status["sync_count"] = status.get("sync_count", 0) + 1
        write_status(status)
        logger.info("Backup synced OK" if ok else "Backup sync failed")
        return ok
    except Exception as e:
        logger.error(f"Backup operation failed: {e}")
        status.update({"last_error": str(e), "db_status": "error"})
        write_status(status)
        return False


def cmd_restore() -> bool:
    logger.info("Restoring from HF Dataset...")
    status = read_status()
    try:
        result = download_and_restore()
        if result is None:
            status.update({"db_status": "connected", "last_error": None})
            write_status(status)
            logger.info("No prior backup — fresh instance")
            return True
        if result:
            status.update({"db_status": "connected", "last_error": None})
            write_status(status)
            logger.info("Restore OK")
            return True
        status.update({"db_status": "error", "last_error": "Restore failed"})
        write_status(status)
        return False
    except Exception as e:
        logger.error(f"Restore operation failed: {e}")
        status.update({"last_error": str(e), "db_status": "error"})
        write_status(status)
        return False


def main():
    if len(sys.argv) < 2:
        print("Usage: postiz-sync.py {sync|restore}")
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "sync":
        sys.exit(0 if cmd_sync() else 1)
    if cmd == "restore":
        sys.exit(0 if cmd_restore() else 1)
    print(f"Unknown command: {cmd}")
    sys.exit(1)


if __name__ == "__main__":
    main()
