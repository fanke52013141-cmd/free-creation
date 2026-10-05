"""Geometry, silhouettes, motion and cuts tested independently of the GPU model."""
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources/video-conversion"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "resources/video-conversion/vendor"))
from clay_renderer import TemporalDepth, normalize_depth, render_clay, scene_cut, surface_normals, ambient_occlusion
from video_depth_anything.dinov2_layers.attention import Attention


class ClayRendererTests(unittest.TestCase):
    def test_flat_surface_has_no_fake_texture_or_shadows(self):
        depth = np.full((80, 120), 0.5, np.float32)
        np.testing.assert_allclose(surface_normals(depth, 1.5, 50)[4:-4, 4:-4],
                                   np.broadcast_to([0, 0, 1], (72, 112, 3)), atol=1e-5)
        self.assertEqual(float(ambient_occlusion(depth).max()), 0)
        image = render_clay(depth, {})
        self.assertEqual(image.dtype, np.uint8)
        self.assertEqual(int(image.max()) - int(image.min()), 0)
        np.testing.assert_array_equal(image[..., 0], image[..., 2])

    def test_curved_surface_has_broad_volume_shading(self):
        y, x = np.mgrid[-1:1:100j, -1:1:100j]
        sphere = np.sqrt(np.maximum(0, 1 - x*x - y*y)).astype(np.float32)
        normal = surface_normals(sphere, 2, 50)
        self.assertGreater(normal[50, 50, 2], 0.95)
        self.assertLess(normal[50, 80, 2], 0.8)
        image = render_clay(sphere, {})
        self.assertGreater(abs(int(image[35, 65, 0]) - int(image[65, 35, 0])), 20)

    def test_depth_break_does_not_bridge_background(self):
        depth = np.zeros((80, 120), np.float32)
        depth[:, 60:] = 1
        normal = surface_normals(depth, 2, 50)
        self.assertGreater(float(normal[3:-3, 59:61, 2].min()), 0.99)
        self.assertEqual(float(ambient_occlusion(depth).max()), 0)

    def test_light_and_shadow_settings_change_pixels(self):
        y, x = np.mgrid[-1:1:80j, -1:1:120j]
        depth = ((x*x + y*y) * 0.25).astype(np.float32)
        first = render_clay(depth, {"lightAzimuth": 0, "shadowStrength": 0})
        second = render_clay(depth, {"lightAzimuth": 180, "shadowStrength": 1})
        self.assertGreater(float(np.mean(np.abs(first.astype(float) - second))), 10)

    def test_invalid_depth_fails_instead_of_silent_black_output(self):
        with self.assertRaises(ValueError):
            normalize_depth(np.array([[float("nan")]], np.float32), 0, 1)

    def test_static_history_reduces_noise_but_cut_resets(self):
        gray = np.full((32, 48), 120, np.uint8)
        depth = np.full((64, 96), 0.5, np.float32)
        temporal = TemporalDepth(1)
        temporal.apply(depth, gray, True)
        filtered = temporal.apply(depth + 0.04, gray, False)
        self.assertLess(float(np.mean(filtered[4:-4, 4:-4])), 0.53)
        np.testing.assert_array_equal(temporal.apply(depth + 0.3, gray, True), depth + 0.3)

    def test_disocclusion_does_not_drag_history(self):
        gray = np.full((32, 48), 120, np.uint8)
        depth = np.full((64, 96), 0.2, np.float32)
        temporal = TemporalDepth(1)
        temporal.apply(depth, gray, True)
        current = depth.copy()
        current[20:40, 30:60] = 0.9
        np.testing.assert_array_equal(temporal.apply(current, gray, False)[20:40, 30:60], current[20:40, 30:60])

    def test_hard_cut_and_same_frame(self):
        first = np.full((32, 48), 30, np.uint8)
        self.assertFalse(scene_cut(first, first))
        self.assertTrue(scene_cut(first, np.full_like(first, 220)))

    def test_efficient_attention_matches_legacy_math(self):
        torch.manual_seed(12)
        attention = Attention(48, 3, qkv_bias=True).eval()
        sample = torch.randn(2, 64, 48)
        with torch.no_grad():
            old = attention(sample)
            attention.use_sdpa = True
            new = attention(sample)
        torch.testing.assert_close(old, new, atol=1e-6, rtol=1e-5)


if __name__ == "__main__":
    unittest.main()
