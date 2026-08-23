from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any
from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")
DATA_DIR = ROOT_DIR / "data"
PROJECT_STORAGE_DIR = ROOT_DIR / "project_storage"


@dataclass(frozen=True)
class ModelProfile:
    id: str
    name: str
    type: str
    provider: str
    base_url: str
    model_id: str
    api_key_env: str
    task_path: str = "/generations/tasks"
    status_path_template: str = "/generations/tasks/{task_id}"
    cancel_path_template: str = ""

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ModelProfile":
        required = ("id", "name", "type", "provider", "base_url", "model_id", "api_key_env")
        missing = [key for key in required if not isinstance(value.get(key), str) or not value[key].strip()]
        if missing:
            raise ValueError(f"模型 profile 缺少字段：{', '.join(missing)}")
        return cls(**{key: value[key] for key in required}, task_path=value.get("task_path", "/generations/tasks"), status_path_template=value.get("status_path_template", "/generations/tasks/{task_id}"), cancel_path_template=value.get("cancel_path_template", ""))

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "type": self.type, "provider": self.provider,
            "baseUrl": self.base_url, "modelId": self.model_id,
        }

    def api_key(self) -> str:
        value = os.getenv(self.api_key_env, "").strip()
        if not value:
            raise RuntimeError(f"服务端未设置模型 {self.name} 的凭据环境变量 {self.api_key_env}")
        return value


@lru_cache
def model_profiles() -> dict[str, ModelProfile]:
    raw = os.getenv("MODEL_PROFILES_JSON", "[]")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("MODEL_PROFILES_JSON 不是合法 JSON") from error
    if not isinstance(values, list):
        raise RuntimeError("MODEL_PROFILES_JSON 必须是 profile 数组")
    profiles = [ModelProfile.from_dict(item) for item in values if isinstance(item, dict)]
    if len({profile.id for profile in profiles}) != len(profiles):
        raise RuntimeError("MODEL_PROFILES_JSON 中存在重复的 id")
    return {profile.id: profile for profile in profiles}


def allowed_origins() -> list[str]:
    return [origin.strip() for origin in os.getenv("APP_CORS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",") if origin.strip()]
