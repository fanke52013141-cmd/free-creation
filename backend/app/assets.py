from __future__ import annotations

import base64
import mimetypes
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .config import PROJECT_STORAGE_DIR
from .database import Database
from .gateway import _is_public_remote_url


MAX_ASSET_BYTES = 100 * 1024 * 1024


def save_asset(db: Database, project_id: str, content: bytes, content_type: str, filename: str) -> str:
    if len(content) > MAX_ASSET_BYTES:
        raise ValueError('生成资产不能超过 100MB')
    asset_id = f"asset_{uuid.uuid4().hex}"
    extension = Path(filename).suffix or mimetypes.guess_extension(content_type) or '.bin'
    relative_path = Path(project_id) / 'assets' / f"{asset_id}{extension}"
    target = PROJECT_STORAGE_DIR / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    db.create_asset(asset_id, project_id, filename, content_type, relative_path.as_posix())
    return f"/assets/{relative_path.as_posix()}"


async def persist_generated_url(db: Database, project_id: str, value: str, kind: str) -> str:
    if value.startswith('data:'):
        header, encoded = value.split(',', 1)
        content_type = header.split(';', 1)[0].split(':', 1)[1]
        return save_asset(db, project_id, base64.b64decode(encoded), content_type, f"generated.{content_type.split('/')[-1]}")
    if not _is_public_remote_url(value):
        raise ValueError('生成结果不是可下载的公开 URL')
    # Never follow a remote redirect blindly: an otherwise public URL could redirect
    # the local gateway to a loopback or private address.
    async with httpx.AsyncClient(timeout=180, follow_redirects=False) as client:
        async with client.stream('GET', value) as response:
            response.raise_for_status()
            declared_size = response.headers.get('content-length')
            if declared_size and int(declared_size) > MAX_ASSET_BYTES:
                raise ValueError('生成资产不能超过 100MB')
            parts: list[bytes] = []
            received = 0
            async for part in response.aiter_bytes():
                received += len(part)
                if received > MAX_ASSET_BYTES:
                    raise ValueError('生成资产不能超过 100MB')
                parts.append(part)
            content = b''.join(parts)
            content_type = response.headers.get('content-type', f"{kind}/mp4" if kind == 'video' else 'image/png').split(';', 1)[0]
    if kind == 'image' and not content_type.startswith('image/'):
        raise ValueError('生成结果不是图片文件')
    if kind == 'video' and not (content_type.startswith('video/') or content_type == 'application/octet-stream'):
        raise ValueError('生成结果不是视频文件')
    suffix = Path(urlparse(value).path).suffix or mimetypes.guess_extension(content_type) or ('.mp4' if kind == 'video' else '.png')
    return save_asset(db, project_id, content, content_type, f"generated{suffix}")
