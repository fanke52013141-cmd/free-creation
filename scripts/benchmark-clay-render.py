"""Local, uncharged source/legacy/new comparison. Explicit input; evidence outside Git."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

import cv2
import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources/video-conversion"))
sys.path.insert(0, str(ROOT / "resources/video-conversion/vendor"))
from runner import read_frames, depth_bounds, clay_frame, MODEL_CONFIG
from clay_renderer import TemporalDepth, normalize_depth, render_clay, scene_cut
from video_depth_anything.video_depth import VideoDepthAnything


def encode(frames, fps, source, destination):
    raw = destination.with_suffix(".rgb")
    with raw.open("wb") as stream:
        for frame in frames:
            stream.write(np.ascontiguousarray(frame).tobytes())
    height, width = frames[0].shape[:2]
    subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
                    "-video_size", f"{width}x{height}", "-framerate", str(fps), "-i", str(raw),
                    "-i", str(source), "-map", "0:v", "-map", "1:a?", "-frames:v", str(len(frames)),
                    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-t", str(len(frames) / fps), "-movflags", "+faststart", "-y", str(destination)], check=True)
    raw.unlink()
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(destination), "-f", "null", "-"], check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    frames, fps = read_frames(args.input, 768)
    guides = [cv2.cvtColor(cv2.resize(frame, (144, 256) if frame.shape[0] > frame.shape[1] else (256, 144)), cv2.COLOR_RGB2GRAY) for frame in frames]
    starts = [0] + [index for index in range(1, len(guides)) if scene_cut(guides[index - 1], guides[index])]
    ends = starts[1:] + [len(frames)]
    model = VideoDepthAnything(**MODEL_CONFIG)
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu", weights_only=True))
    model = model.to("cuda").eval()
    for module in model.modules():
        if hasattr(module, "use_sdpa"):
            module.use_sdpa = True
    reports, renders = [], {}
    for quality, size in (("fast", 518), ("standard", 644), ("fine", 770)):
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        parts = [model.infer_video_depth(frames[start:end], fps, input_size=size, device="cuda")[0]
                 for start, end in zip(starts, ends)]
        depths = np.concatenate(parts) if len(parts) > 1 else parts[0]
        inference_seconds = time.perf_counter() - started
        np.save(output / f"depth-{quality}.npy", depths)
        bounds = [depth_bounds(depths[start:end]) for start, end in zip(starts, ends)]
        temporal = TemporalDepth(0.6)
        rendered = []
        render_start = time.perf_counter()
        for shot, (start, end) in enumerate(zip(starts, ends)):
            for index in range(start, end):
                normalized = normalize_depth(depths[index], *bounds[shot])
                stable = temporal.apply(normalized, guides[index], index == start)
                rendered.append(render_clay(stable, {"lightElevation": 45}))
        render_seconds = time.perf_counter() - render_start
        renders[quality] = rendered
        encode(rendered, fps, args.input, output / f"clay-{quality}.mp4")
        reports.append({"quality": quality, "inputSize": size, "inferenceSeconds": round(inference_seconds, 3),
                        "renderSeconds": round(render_seconds, 3), "peakAllocatedMiB": round(torch.cuda.max_memory_allocated() / 2**20),
                        "frames": len(depths), "shots": len(starts), "decoded": True})
        if quality == "fast":
            low, high = depth_bounds(depths)
            legacy = [clay_frame(depth, low, high, {}) for depth in depths]
            encode(legacy, fps, args.input, output / "clay-legacy.mp4")
            renders["legacy"] = legacy
        print(json.dumps(reports[-1]), flush=True)
    comparison = []
    for index in range(len(frames)):
        panels = []
        for label, frame in (("Source", frames[index]), ("Legacy", renders["legacy"][index]),
                             ("New - same depth", renders["fast"][index]), ("New - standard", renders["standard"][index])):
            panel = cv2.resize(frame, (288, 512) if frame.shape[0] > frame.shape[1] else (512, 288))
            cv2.rectangle(panel, (0, 0), (panel.shape[1], 28), (20, 25, 30), -1)
            cv2.putText(panel, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (235, 235, 235), 1, cv2.LINE_AA)
            panels.append(panel)
        comparison.append(np.concatenate(panels, axis=1))
    encode(comparison, fps, args.input, output / "comparison.mp4")
    for fraction in (0, 0.5, 0.9):
        frame = comparison[min(len(comparison)-1, int(len(comparison)*fraction))]
        cv2.imwrite(str(output / f"comparison-{fraction}.png"), cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
    (output / "benchmark.json").write_text(json.dumps({"gpu": torch.cuda.get_device_name(), "fps": fps,
                                                    "results": reports}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
