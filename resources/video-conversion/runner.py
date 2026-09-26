"""Local Video Depth Anything inference and depth/clay render worker.

Input and output are explicit filesystem arguments supplied by the trusted main process.
Progress is emitted as JSON Lines; video frames are written as raw RGB for FFmpeg to encode.
"""
from __future__ import annotations

import argparse
import gc
import json

import cv2
import numpy as np
import torch

from video_depth_anything.video_depth import VideoDepthAnything


MODEL_CONFIG = {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]}
MAX_FRAMES = 1800


def emit(stage: str, **values: object) -> None:
    print(json.dumps({"stage": stage, **values}, ensure_ascii=False), flush=True)


def read_frames(path: str, max_resolution: int) -> tuple[np.ndarray, float]:
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError("无法解码输入视频，请先用 FFmpeg 支持的格式转码")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    if not np.isfinite(fps) or fps <= 0 or fps > 240:
        fps = 30.0
    frames: list[np.ndarray] = []
    try:
        while True:
            ok, bgr = capture.read()
            if not ok:
                break
            height, width = bgr.shape[:2]
            scale = min(1.0, max_resolution / max(width, height))
            output_width = max(2, int(round(width * scale)))
            output_height = max(2, int(round(height * scale)))
            output_width -= output_width % 2
            output_height -= output_height % 2
            if output_width != width or output_height != height:
                bgr = cv2.resize(
                    bgr,
                    (output_width, output_height),
                    interpolation=cv2.INTER_AREA,
                )
            frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            if len(frames) > MAX_FRAMES:
                raise RuntimeError("当前版本单次最多处理 1800 帧，请先截短视频后重试")
    finally:
        capture.release()
    if not frames:
        raise RuntimeError("视频中没有可解码的画面")
    return np.stack(frames), fps


def depth_bounds(depths: np.ndarray) -> tuple[float, float]:
    frame_step = max(1, len(depths) // 16)
    row_step = max(1, depths.shape[1] // 72)
    column_step = max(1, depths.shape[2] // 128)
    sample = depths[::frame_step, ::row_step, ::column_step]
    low = float(np.percentile(sample, 2))
    high = float(np.percentile(sample, 98))
    if not np.isfinite(low) or not np.isfinite(high) or high <= low:
        high = low + 1.0
    return low, high


def depth_gray(depths: np.ndarray, low: float, high: float, near_color: str) -> np.ndarray:
    result = np.clip((depths - low) / (high - low), 0.0, 1.0)
    if near_color == "black":
        result = 1.0 - result
    return np.round(result * 255).astype(np.uint8)


def clay_frame(depth: np.ndarray, low: float, high: float, config: dict[str, object]) -> np.ndarray:
    normalized = np.clip((depth.astype(np.float32) - low) / max(high - low, 1e-6), 0.0, 1.0)
    smooth = cv2.GaussianBlur(normalized, (0, 0), 1.1)
    dy, dx = np.gradient(smooth)
    strength = float(config.get("reliefStrength", 1.5)) * max(depth.shape) * 0.12
    nx, ny, nz = -dx * strength, -dy * strength, np.ones_like(depth, dtype=np.float32)
    length = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-6
    nx, ny, nz = nx / length, ny / length, nz / length

    azimuth = np.deg2rad(float(config.get("lightAzimuth", 315)))
    elevation = np.deg2rad(float(config.get("lightElevation", 35)))
    light = np.array(
        [np.cos(elevation) * np.cos(azimuth), np.cos(elevation) * np.sin(azimuth), np.sin(elevation)],
        dtype=np.float32,
    )
    diffuse = np.maximum(0.0, nx * light[0] + ny * light[1] + nz * light[2])
    ambient = float(config.get("ambientLight", 0.42))
    shade = np.clip(ambient + (1.0 - ambient) * diffuse, 0.0, 1.0)
    gray = np.round(shade * 255).astype(np.uint8)
    return np.repeat(gray[:, :, None], 3, axis=2)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output-raw", required=True)
    parser.add_argument("--output-meta", required=True)
    parser.add_argument("--mode", choices=("depth", "clay", "both"), required=True)
    parser.add_argument("--output-raw-clay")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("未检测到可用 CUDA 显卡；本地视频深度推理当前不支持 CPU 模式")
    config = json.loads(args.config)
    emit("decode")
    frames, fps = read_frames(args.input, int(config.get("maxResolution", 512)))
    height, width = frames.shape[1:3]
    emit("inference", frames=len(frames), width=width, height=height, fps=fps)

    model = VideoDepthAnything(**MODEL_CONFIG)
    weights = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(weights, strict=True)
    model = model.to("cuda").eval()
    depths, _ = model.infer_video_depth(frames, fps, input_size=518, device="cuda")
    del frames
    del model
    torch.cuda.empty_cache()
    gc.collect()

    emit("render", frames=len(depths))
    low, high = depth_bounds(depths)
    if args.mode in ("depth", "both"):
        gray = depth_gray(depths, low, high, str(config.get("nearColor", "white")))
    else:
        gray = None
    if args.mode == "both" and not args.output_raw_clay:
        raise RuntimeError("同时导出模式需要指定 --output-raw-clay")
    with open(args.output_raw, "wb") as raw:
        clay_raw = open(args.output_raw_clay, "wb") if args.mode in ("clay", "both") else None
        try:
            for index, depth in enumerate(depths):
                if gray is not None:
                    depth_rgb = np.repeat(gray[index, :, :, None], 3, axis=2)
                    raw.write(np.ascontiguousarray(depth_rgb).tobytes())
                else:
                    clay_raw.write(np.ascontiguousarray(clay_frame(depth, low, high, config)).tobytes())
                if clay_raw is not None and args.mode == "both":
                    clay_raw.write(np.ascontiguousarray(clay_frame(depth, low, high, config)).tobytes())
                if index and index % 60 == 0:
                    emit("render", done=index, total=len(depths))
        finally:
            if clay_raw is not None:
                clay_raw.close()

    with open(args.output_meta, "w", encoding="utf-8") as metadata:
        json.dump({"width": width, "height": height, "fps": fps, "frames": len(depths)}, metadata)
    emit("done", frames=len(depths))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("error", message=str(error))
        raise
