"""Visible-surface clay rendering. Relative inverse depth is not metric geometry.

No textures enter the material. RGB is used only for cut detection and motion alignment.
All state is per conversion; hidden surfaces are never synthesized.
"""
from __future__ import annotations

import cv2
import numpy as np


def normalize_depth(depth: np.ndarray, low: float, high: float) -> np.ndarray:
    if not np.isfinite(depth).all():
        raise ValueError("深度推理包含无效数值")
    return np.clip((depth.astype(np.float32) - low) / max(high - low, 1e-6), 0, 1)


def surface_normals(inverse_depth: np.ndarray, strength: float, field_of_view: float) -> np.ndarray:
    height, width = inverse_depth.shape
    # A bounded artistic mapping, not a claim of meters from relative inverse depth.
    distance = np.exp(-inverse_depth * strength * 0.55)
    focal = width / (2 * np.tan(np.deg2rad(field_of_view) / 2))
    yy, xx = np.mgrid[:height, :width].astype(np.float32)
    points = np.stack(((xx - (width - 1) / 2) * distance / focal,
                       -(yy - (height - 1) / 2) * distance / focal, -distance), axis=-1)
    padded = np.pad(points, ((1, 1), (1, 1), (0, 0)), mode="edge")
    left, right = points - padded[1:-1, :-2], padded[1:-1, 2:] - points
    up, down = padded[:-2, 1:-1] - points, points - padded[2:, 1:-1]
    # Choose the same-surface neighbor at discontinuities instead of bridging foreground/background.
    tangent_x = np.where((np.abs(left[..., 2]) < np.abs(right[..., 2]))[..., None], left, right)
    tangent_y = np.where((np.abs(up[..., 2]) < np.abs(down[..., 2]))[..., None], up, down)
    normals = np.cross(tangent_x, tangent_y)
    lengths = np.linalg.norm(normals, axis=-1, keepdims=True)
    normals /= np.maximum(lengths, 1e-8)
    normals[lengths[..., 0] < 1e-8] = (0, 0, 1)
    return normals


def ambient_occlusion(depth: np.ndarray) -> np.ndarray:
    height, width = depth.shape
    scale = max(height, width) / 512
    obscured = np.zeros_like(depth)
    count = np.zeros_like(depth)
    for radius in (3, 9, 20):
        step = max(1, round(radius * scale))
        pad = np.pad(depth, step, mode="edge")
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            neighbor = pad[step + dy * step:step + dy * step + height,
                           step + dx * step:step + dx * step + width]
            delta = neighbor - depth
            # Reject depth breaks: otherwise a dark halo is drawn around every silhouette.
            valid = np.abs(delta) < 0.12
            obscured += np.clip((delta - 0.008) / 0.07, 0, 1) * valid
            count += valid
    return obscured / np.maximum(count, 1)


def smooth_surface_normals(normals: np.ndarray, depth: np.ndarray) -> np.ndarray:
    """Suppress single-pixel normal spikes without blending separate surfaces.

    Depth inference has staircase edges; differentiating them magnifies noise into
    dark ink-like outlines. Filter orientations, not source RGB or material color.
    """
    height, width = depth.shape
    accumulated = normals.copy()
    weights = np.ones_like(depth)
    for radius in (2, 5):
        step = max(1, round(radius * max(height, width) / 512))
        padded_depth = np.pad(depth, step, mode="edge")
        padded_normals = np.pad(normals, ((step, step), (step, step), (0, 0)), mode="edge")
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            rows = slice(step + dy * step, step + dy * step + height)
            columns = slice(step + dx * step, step + dx * step + width)
            delta = padded_depth[rows, columns] - depth
            weight = np.exp(-np.square(delta / 0.025)) * (np.abs(delta) < 0.06)
            accumulated += padded_normals[rows, columns] * weight[..., None]
            weights += weight
    averaged = accumulated / weights[..., None]
    return averaged / np.maximum(np.linalg.norm(averaged, axis=-1, keepdims=True), 1e-8)


def render_clay(normalized: np.ndarray, config: dict[str, object]) -> np.ndarray:
    smooth = cv2.bilateralFilter(normalized, 7, 0.045, 2.5)
    normals = surface_normals(smooth, float(config.get("reliefStrength", 1.5)),
                              float(config.get("fieldOfView", 50)))
    normals = smooth_surface_normals(normals, smooth)
    azimuth = np.deg2rad(float(config.get("lightAzimuth", 315)))
    elevation = np.deg2rad(float(config.get("lightElevation", 45)))
    # Azimuth is image-plane direction; elevation lifts the light toward the viewer.
    light = np.array([np.cos(elevation) * np.cos(azimuth),
                      -np.cos(elevation) * np.sin(azimuth), np.sin(elevation)], dtype=np.float32)
    diffuse = np.clip((np.sum(normals * light, axis=-1) + 0.12) / 1.12, 0, 1)
    fill = np.maximum(0, np.sum(normals * np.array([-0.4, 0.25, 0.88]), axis=-1))
    hemisphere = 0.55 + 0.2 * normals[..., 1] + 0.25 * np.maximum(normals[..., 2], 0)
    ambient = float(config.get("ambientLight", 0.42))
    illumination = ambient * hemisphere + (1 - ambient) * (0.82 * diffuse + 0.18 * fill)
    occlusion = ambient_occlusion(smooth) if float(config.get("shadowStrength", 0.35)) > 0 else 0
    illumination *= 1 - float(config.get("shadowStrength", 0.35)) * occlusion
    # Linear matte-white reflectance, then display gamma. No source colors or texture.
    gray = np.round(np.power(np.clip(0.82 * illumination, 0, 1), 1 / 2.2) * 255).astype(np.uint8)
    return np.repeat(gray[..., None], 3, axis=2)


def scene_cut(previous: np.ndarray, current: np.ndarray) -> bool:
    old_hist = cv2.calcHist([previous], [0], None, [32], [0, 256])
    new_hist = cv2.calcHist([current], [0], None, [32], [0, 256])
    cv2.normalize(old_hist, old_hist, norm_type=cv2.NORM_L1)
    cv2.normalize(new_hist, new_hist, norm_type=cv2.NORM_L1)
    distance = cv2.compareHist(old_hist, new_hist, cv2.HISTCMP_BHATTACHARYYA)
    difference = np.mean(np.abs(current.astype(np.float32) - previous)) / 255
    return bool(distance > 0.5 and difference > 0.18 or difference > 0.42)


class TemporalDepth:
    """Motion-compensated history, rejected at cuts, occlusions and disocclusions."""

    def __init__(self, stability: float):
        self.stability = stability
        self.gray: np.ndarray | None = None
        self.depth: np.ndarray | None = None

    def apply(self, depth: np.ndarray, gray: np.ndarray, cut: bool) -> np.ndarray:
        output = depth
        if self.stability > 0 and not cut and self.gray is not None and self.depth is not None:
            height, width = depth.shape
            flow = cv2.calcOpticalFlowFarneback(gray, self.gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            reverse = cv2.calcOpticalFlowFarneback(self.gray, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            guide_height, guide_width = gray.shape
            flow_scale = np.array((width / guide_width, height / guide_height), dtype=np.float32)
            flow = cv2.resize(flow, (width, height)) * flow_scale
            reverse = cv2.resize(reverse, (width, height)) * flow_scale
            full_gray = cv2.resize(gray, (width, height))
            previous_gray = cv2.resize(self.gray, (width, height))
            yy, xx = np.mgrid[:height, :width].astype(np.float32)
            map_x, map_y = xx + flow[..., 0], yy + flow[..., 1]
            history = cv2.remap(self.depth, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            old_gray = cv2.remap(previous_gray, map_x, map_y, cv2.INTER_LINEAR)
            back = cv2.remap(reverse, map_x, map_y, cv2.INTER_LINEAR)
            valid = ((map_x >= 0) & (map_x < width - 1) & (map_y >= 0) & (map_y < height - 1)
                     & (np.linalg.norm(flow + back, axis=-1) < 1.5)
                     & (np.abs(history - depth) < 0.08)
                     & (np.abs(full_gray.astype(np.float32) - old_gray) < 24))
            weight = valid.astype(np.float32) * self.stability * 0.5
            output = depth * (1 - weight) + history * weight
        self.gray, self.depth = gray, output
        return output
