from __future__ import annotations

import asyncio
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import DATA_DIR, PROJECT_STORAGE_DIR, allowed_origins, model_profiles
from .database import Database
from .gateway import cancel_seedance_task, generate_chat, generate_image, run_seedance_task
from .assets import persist_generated_url


db = Database(DATA_DIR / "canvas.db")
job_queue: asyncio.Queue[str] = asyncio.Queue()
worker_tasks: list[asyncio.Task[None]] = []


def profile_or_422(profile_id: str, required_type: str):
    profile = model_profiles().get(profile_id)
    if not profile:
        raise HTTPException(422, "所选模型未在服务端登记，请在 Model 配置中同步服务端模型。")
    if profile.type != required_type:
        raise HTTPException(422, f"模型 {profile.name} 不是 {required_type} 类型")
    return profile


class ChatRequest(BaseModel):
    profileId: str
    messages: list[dict[str, str]] = Field(min_length=1, max_length=200)
    temperature: float = Field(default=0.7, ge=0, le=2)
    maxTokens: int = Field(default=2048, ge=1, le=16000)


class ImageRequest(BaseModel):
    profileId: str
    prompt: str = Field(min_length=1, max_length=16000)
    referenceUrls: list[str] = Field(default_factory=list, max_length=8)
    size: str = Field(default="1024x1024", max_length=32)
    quality: str = Field(default="standard", max_length=32)


class VideoRequest(BaseModel):
    projectId: str
    profileId: str
    prompts: list[str] = Field(min_length=1, max_length=100)
    referenceUrls: list[str] = Field(default_factory=list, max_length=4)
    resolution: str = Field(default="720p", pattern="^(480p|720p|1080p)$")
    duration: int = Field(default=4, ge=2, le=15)


class ImageTaskRequest(BaseModel):
    projectId: str
    profileId: str
    prompts: list[str] = Field(min_length=1, max_length=100)
    referenceUrls: list[str] = Field(default_factory=list, max_length=8)
    size: str = Field(default="1024x1024", max_length=32)
    quality: str = Field(default="standard", max_length=32)


class CanvasRequest(BaseModel):
    shapes: list[dict[str, Any]] = Field(max_length=5000)


class AssetImportRequest(BaseModel):
    url: str = Field(min_length=1, max_length=8000)


def task_response(task: dict[str, Any]) -> dict[str, Any]:
    return {"id": task["id"], "status": task["status"], "progress": task["progress"], "result_urls": task["result_urls"], "error": task.get("error")}


async def execute_job(task_id: str) -> None:
    task = db.get_task(task_id)
    if not task or task["status"] == "canceled":
        return
    db.update_task(task_id, status="running", progress=1)
    try:
        request = task["request"]
        prompts = request["prompts"]
        urls: list[str] = []
        if task["kind"] == "image":
            profile = profile_or_422(task["profile_id"], "image")
            for index, prompt in enumerate(prompts):
                generated = await generate_image(profile, prompt, request["reference_urls"], request["size"], request["quality"])
                for value in generated:
                    urls.append(await persist_generated_url(db, request["project_id"], value, "image"))
                db.update_task(task_id, progress=round((index + 1) / len(prompts) * 100))
        elif task["kind"] == "video":
            profile = profile_or_422(task["profile_id"], "video")
            if profile.provider != "seedance":
                raise RuntimeError(f"尚未实现视频 provider：{profile.provider}")
            for index, prompt in enumerate(prompts):
                async def on_update(**patch: Any) -> None:
                    current = db.get_task(task_id)
                    if current and current["status"] == "canceled":
                        raise RuntimeError("任务已取消")
                    if "progress" in patch:
                        patch["progress"] = round((index + patch["progress"] / 100) / len(prompts) * 100)
                    db.update_task(task_id, **patch)
                generated = await run_seedance_task(profile, { **request, "prompt": prompt }, on_update)
                for value in generated:
                    urls.append(await persist_generated_url(db, request["project_id"], value, "video"))
        else:
            raise RuntimeError(f"未知任务类型：{task['kind']}")
        current = db.get_task(task_id)
        if current and current["status"] != "canceled":
            db.update_task(task_id, status="done", progress=100, result_urls=urls)
    except Exception as error:  # errors are deliberately surfaced to the node, not logged with credentials
        current = db.get_task(task_id)
        if current and current["status"] != "canceled":
            db.update_task(task_id, status="failed", error=str(error)[:1000])


async def queue_worker() -> None:
    while True:
        task_id = await job_queue.get()
        try:
            await execute_job(task_id)
        finally:
            job_queue.task_done()


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.initialize()
    for task_id in db.recover_tasks():
        await job_queue.put(task_id)
    worker_count = max(1, int(__import__("os").getenv("TASK_WORKERS", "1")))
    worker_tasks.extend(asyncio.create_task(queue_worker()) for _ in range(worker_count))
    yield
    for task in worker_tasks:
        task.cancel()
    await asyncio.gather(*worker_tasks, return_exceptions=True)


app = FastAPI(title="Infinite Canvas Gateway", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=allowed_origins(), allow_credentials=False, allow_methods=["GET", "POST", "PUT"], allow_headers=["Content-Type"])
PROJECT_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=PROJECT_STORAGE_DIR), name="assets")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "profiles": len(model_profiles()), "queue_depth": job_queue.qsize()}


@app.get("/api/models")
async def models() -> dict[str, Any]:
    return {"items": [profile.public_dict() for profile in model_profiles().values()]}


@app.post("/api/generate/chat")
async def chat(request: ChatRequest) -> dict[str, str]:
    try:
        content = await generate_chat(profile_or_422(request.profileId, "chat"), request.messages, request.temperature, request.maxTokens)
        return {"content": content}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, f"聊天模型调用失败：{str(error)[:400]}") from error


@app.post("/api/generate/image")
async def image(request: ImageRequest) -> dict[str, list[str]]:
    try:
        urls = await generate_image(profile_or_422(request.profileId, "image"), request.prompt, request.referenceUrls, request.size, request.quality)
        return {"urls": urls}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(502, f"图片模型调用失败：{str(error)[:400]}") from error


@app.post("/api/tasks/video")
async def create_video_task(request: VideoRequest) -> dict[str, Any]:
    safe_project_id(request.projectId)
    profile_or_422(request.profileId, "video")
    task_id = f"video_{uuid.uuid4().hex}"
    db.create_task(task_id, "video", request.profileId, {"project_id": request.projectId, "prompts": request.prompts, "reference_urls": request.referenceUrls, "resolution": request.resolution, "duration": request.duration})
    await job_queue.put(task_id)
    task = db.get_task(task_id)
    assert task
    return task_response(task)


@app.post("/api/tasks/image")
async def create_image_task(request: ImageTaskRequest) -> dict[str, Any]:
    safe_project_id(request.projectId)
    profile_or_422(request.profileId, "image")
    task_id = f"image_{uuid.uuid4().hex}"
    db.create_task(task_id, "image", request.profileId, {"project_id": request.projectId, "prompts": request.prompts, "reference_urls": request.referenceUrls, "size": request.size, "quality": request.quality})
    await job_queue.put(task_id)
    task = db.get_task(task_id)
    assert task
    return task_response(task)


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str) -> dict[str, Any]:
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    return task_response(task)


@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task(task_id: str) -> dict[str, Any]:
    task = db.get_task(task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    if task["status"] not in {"done", "failed", "canceled"}:
        canceled_upstream = False
        if task["kind"] == "video" and task.get("upstream_task_id"):
            profile = profile_or_422(task["profile_id"], "video")
            canceled_upstream = await cancel_seedance_task(profile, task["upstream_task_id"])
        message = "已取消上游任务" if canceled_upstream else "已停止本地任务；供应商未提供取消接口时仍可能产生费用"
        db.update_task(task_id, status="canceled", error=message)
    updated = db.get_task(task_id)
    assert updated
    return task_response(updated)


def safe_project_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise HTTPException(400, "非法项目 id")
    return value


@app.put("/api/projects/{project_id}/canvas")
async def save_canvas(project_id: str, payload: CanvasRequest) -> dict[str, bool]:
    safe_project_id(project_id)
    if len(str(payload.shapes)) > 10 * 1024 * 1024:
        raise HTTPException(413, "画布快照不能超过 10MB")
    db.put_snapshot(project_id, payload.shapes)
    return {"ok": True}


@app.get("/api/projects/{project_id}/canvas")
async def get_canvas(project_id: str) -> dict[str, Any]:
    safe_project_id(project_id)
    shapes = db.get_snapshot(project_id)
    if shapes is None:
        raise HTTPException(404, "尚未保存服务端快照")
    return {"shapes": shapes}


@app.post("/api/projects/{project_id}/assets")
async def upload_asset(project_id: str, file: Annotated[UploadFile, File(...)]) -> dict[str, str]:
    safe_project_id(project_id)
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(415, "目前仅支持图片资产")
    content = await file.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(413, "图片不能超过 15MB")
    asset_id = f"asset_{uuid.uuid4().hex}"
    extension = Path(file.filename or "image.png").suffix.lower() or ".png"
    relative_path = Path(project_id) / "assets" / f"{asset_id}{extension}"
    target = PROJECT_STORAGE_DIR / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    db.create_asset(asset_id, project_id, file.filename or target.name, file.content_type, relative_path.as_posix())
    return {"id": asset_id, "url": f"/assets/{relative_path.as_posix()}"}


@app.post("/api/projects/{project_id}/assets/import")
async def import_asset(project_id: str, request: AssetImportRequest) -> dict[str, str]:
    safe_project_id(project_id)
    url = await persist_generated_url(db, project_id, request.url, "image")
    return {"id": Path(url).stem, "url": url}
