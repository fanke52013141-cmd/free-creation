from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import socket
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from .config import ModelProfile


def endpoint(base_url: str, path: str) -> str:
    return urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))


def image_urls(payload: Any) -> list[str]:
    items = payload.get("data", []) if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return []
    urls: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("url"), str):
            urls.append(item["url"])
        elif isinstance(item.get("b64_json"), str):
            urls.append(f"data:image/png;base64,{item['b64_json']}")
    return urls


def _is_public_remote_url(value: str) -> bool:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    try:
        addresses = socket.getaddrinfo(parsed.hostname, None)
        return all(not ipaddress.ip_address(address[4][0]).is_private and not ipaddress.ip_address(address[4][0]).is_loopback and not ipaddress.ip_address(address[4][0]).is_link_local for address in addresses)
    except socket.gaierror:
        return False


async def reference_file(client: httpx.AsyncClient, value: str, index: int) -> tuple[str, bytes, str]:
    if value.startswith("data:image/"):
        try:
            header, encoded = value.split(",", 1)
            mime = header.split(";", 1)[0].split(":", 1)[1]
            return (f"reference-{index}.png", base64.b64decode(encoded), mime)
        except (ValueError, IndexError) as error:
            raise ValueError("图片 data URL 无法解析") from error
    if not _is_public_remote_url(value):
        raise ValueError("参考图只允许公开的 http(s) 图片地址或 data:image URL")
    response = await client.get(value, follow_redirects=False)
    response.raise_for_status()
    mime = response.headers.get("content-type", "image/png").split(";", 1)[0]
    if not mime.startswith("image/"):
        raise ValueError("参考地址不是图片")
    if len(response.content) > 15 * 1024 * 1024:
        raise ValueError("参考图不能超过 15MB")
    return (f"reference-{index}.{mime.split('/')[-1]}", response.content, mime)


async def generate_chat(profile: ModelProfile, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    payload = {"model": profile.model_id, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(endpoint(profile.base_url, "/chat/completions"), headers={"Authorization": f"Bearer {profile.api_key()}"}, json=payload)
    response.raise_for_status()
    content = response.json().get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content:
        raise RuntimeError("上游聊天接口没有返回 content")
    return content


async def generate_image(profile: ModelProfile, prompt: str, references: list[str], size: str, quality: str) -> list[str]:
    async with httpx.AsyncClient(timeout=180) as client:
        headers = {"Authorization": f"Bearer {profile.api_key()}"}
        if references:
            files = [("image", await reference_file(client, value, index)) for index, value in enumerate(references, 1)]
            data = {"model": profile.model_id, "prompt": prompt, "size": size, "quality": quality}
            response = await client.post(endpoint(profile.base_url, "/images/edits"), headers=headers, data=data, files=files)
        else:
            response = await client.post(endpoint(profile.base_url, "/images/generations"), headers={**headers, "Content-Type": "application/json"}, json={"model": profile.model_id, "prompt": prompt, "size": size, "quality": quality, "n": 1})
    response.raise_for_status()
    urls = image_urls(response.json())
    if not urls:
        raise RuntimeError("上游图片接口未返回 url 或 b64_json")
    return urls


def find_by_key(value: Any, accepted: set[str]) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in accepted and isinstance(child, str) and child.startswith(("http://", "https://")):
                found.append(child)
            found.extend(find_by_key(child, accepted))
    elif isinstance(value, list):
        for child in value:
            found.extend(find_by_key(child, accepted))
    return list(dict.fromkeys(found))


def upstream_task_id(payload: dict[str, Any]) -> str | None:
    for key in ("id", "task_id", "taskId", "request_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    data = payload.get("data")
    return upstream_task_id(data) if isinstance(data, dict) else None


def upstream_status(payload: dict[str, Any]) -> str:
    for key in ("status", "state"):
        value = payload.get(key)
        if isinstance(value, str):
            return value.lower()
    data = payload.get("data")
    return upstream_status(data) if isinstance(data, dict) else "running"


async def run_seedance_task(profile: ModelProfile, request: dict[str, Any], on_update: Any) -> list[str]:
    content: list[dict[str, Any]] = [{"type": "text", "text": f"{request['prompt']} --resolution {request['resolution']} --duration {request['duration']}"}]
    content.extend({"type": "image_url", "image_url": {"url": value}} for value in request["reference_urls"])
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(endpoint(profile.base_url, profile.task_path), headers={"Authorization": f"Bearer {profile.api_key()}", "Content-Type": "application/json"}, json={"model": profile.model_id, "content": content})
        response.raise_for_status()
        payload = response.json()
        urls = find_by_key(payload, {"url", "video_url", "video"})
        if urls:
            return urls
        task_id = upstream_task_id(payload)
        if not task_id:
            raise RuntimeError("视频供应商未返回任务 id 或视频结果")
        await on_update(upstream_task_id=task_id, progress=10)
        for attempt in range(120):
            await asyncio.sleep(3)
            status_response = await client.get(endpoint(profile.base_url, profile.status_path_template.format(task_id=task_id)), headers={"Authorization": f"Bearer {profile.api_key()}"})
            status_response.raise_for_status()
            status_payload = status_response.json()
            urls = find_by_key(status_payload, {"url", "video_url", "video"})
            if urls:
                return urls
            state = upstream_status(status_payload)
            if state in {"failed", "error", "cancelled", "canceled"}:
                raise RuntimeError(json.dumps(status_payload, ensure_ascii=False)[:400])
            await on_update(progress=min(95, 10 + attempt))
    raise TimeoutError("视频任务轮询超时")


async def cancel_seedance_task(profile: ModelProfile, task_id: str) -> bool:
    if not profile.cancel_path_template:
        return False
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(endpoint(profile.base_url, profile.cancel_path_template.format(task_id=task_id)), headers={"Authorization": f"Bearer {profile.api_key()}"})
    response.raise_for_status()
    return True
