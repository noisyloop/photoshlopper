# Bundled models

## u2netp.onnx — U²-Net-P salient object segmentation

Used by **Layer ▸ Remove Background…** (runs locally via onnxruntime-web).

- Model: U²-Net (small variant, U²-NetP) by Xuebin Qin et al.,
  "U²-Net: Going Deeper with Nested U-Structure for Salient Object
  Detection", Pattern Recognition 2020 — https://github.com/xuebinqin/U-2-Net
- License: Apache License 2.0
- ONNX export as distributed by rembg
  (https://github.com/danielgatis/rembg/releases/tag/v0.0.0),
  md5 `8e83ca70e441ab06c318d82300c84806`
- Input `1×3×320×320` float32 (RGB / max, ImageNet mean/std); first output
  is the saliency map, min-max normalized by the app.
