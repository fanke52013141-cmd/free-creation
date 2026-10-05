"""Compare two renderers on identical cached depth; no model calls or downloads."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "resources/video-conversion"))
sys.path.insert(0, str(ROOT / "resources/video-conversion/vendor"))
from clay_renderer import TemporalDepth, normalize_depth, render_clay, scene_cut
from runner import read_frames, depth_bounds
benchmark_spec = importlib.util.spec_from_file_location("benchmark", ROOT / "scripts/benchmark-clay-render.py")
benchmark = importlib.util.module_from_spec(benchmark_spec)
benchmark_spec.loader.exec_module(benchmark)
encode = benchmark.encode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--depth", required=True)
    parser.add_argument("--previous-renderer", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("previous_clay_renderer", args.previous_renderer)
    previous = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(previous)
    frames, fps = read_frames(args.source, 768)
    depths = np.load(args.depth, allow_pickle=False)
    if len(depths) != len(frames):
        raise ValueError("Cached depth and source must have the same frame count")
    height, width = frames[0].shape[:2]
    ratio = 256 / max(height, width)
    guides = [cv2.cvtColor(cv2.resize(frame, (max(1, round(width * ratio)),
        max(1, round(height * ratio)))), cv2.COLOR_RGB2GRAY) for frame in frames]
    starts = [0] + [index for index in range(1, len(guides)) if scene_cut(guides[index - 1], guides[index])]
    ends = starts[1:] + [len(frames)]
    bounds = [depth_bounds(depths[start:end]) for start, end in zip(starts, ends)]
    shot = 0
    temporal = TemporalDepth(0.6)
    old_frames, new_frames, comparisons = [], [], []
    old_seconds = new_seconds = 0
    for index, (frame, depth) in enumerate(zip(frames, depths)):
        if shot + 1 < len(starts) and index >= starts[shot + 1]:
            shot += 1
        stable = temporal.apply(normalize_depth(depth, *bounds[shot]), guides[index], index == starts[shot])
        started = time.perf_counter()
        old = previous.render_clay(stable, {})
        old_seconds += time.perf_counter() - started
        started = time.perf_counter()
        new = render_clay(stable, {})
        new_seconds += time.perf_counter() - started
        old_frames.append(old)
        new_frames.append(new)
        panels = []
        for label, content in (("Source", frame), ("First iteration", old), ("Refined normals", new)):
            panel_size = (288, 512) if height > width else (512, 288)
            panel = cv2.resize(content, panel_size)
            cv2.rectangle(panel, (0, 0), (panel_size[0], 28), (20, 25, 30), -1)
            cv2.putText(panel, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (235, 235, 235), 1)
            panels.append(panel)
        comparisons.append(np.concatenate(panels, axis=1))
    encode(old_frames, fps, args.source, output / "previous.mp4")
    encode(new_frames, fps, args.source, output / "refined.mp4")
    encode(comparisons, fps, args.source, output / "comparison.mp4")
    for fraction in (0, 0.5, 0.9):
        frame = comparisons[min(len(comparisons) - 1, int(len(comparisons) * fraction))]
        cv2.imwrite(str(output / f"comparison-{fraction}.png"), cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
    (output / "results.json").write_text(json.dumps({"frames": len(frames), "fps": fps,
        "previousRenderSeconds": old_seconds, "refinedRenderSeconds": new_seconds,
        "fullDecode": True}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
