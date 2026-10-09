# Third-party notices

このリポジトリには次のサードパーティのコードを同梱しています（`studio/lib/`）。

## three.js（r166）

- 同梱ファイル: `studio/lib/three.module.js`, `studio/lib/jsm/loaders/GLTFLoader.js`,
  `studio/lib/jsm/objects/GroundedSkybox.js`, `studio/lib/jsm/utils/BufferGeometryUtils.js`
- https://github.com/mrdoob/three.js — MIT License

```
The MIT License

Copyright © 2010-2024 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## @pixiv/three-vrm（v3.4.4・ビルド済み単一ファイル）

- 同梱ファイル: `studio/lib/three-vrm.module.min.js`
- https://github.com/pixiv/three-vrm — MIT License

```
MIT License

Copyright (c) 2019-2025 pixiv Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 同梱していないが、ツールが使うもの（利用者が別途インストール）

| もの | 用途 | ライセンス |
|---|---|---|
| Depth Anything V2 Small（`depth-anything/Depth-Anything-V2-Small-hf`） | `tools/make_depth.py` の深度推定（初回に自動ダウンロード） | Apache-2.0（Base / Large は CC-BY-NC-4.0＝非商用のみ） |
| Hugging Face transformers / PyTorch | 同上 | Apache-2.0 / BSD-3-Clause |
| PyMuPDF | `tools/pdf_to_slides.py`（PDF → PNG） | AGPL-3.0（または Artifex の商用ライセンス）。手元の変換ツールとして使うだけで、このリポジトリには同梱せず、requirements.txt にも入れていません（使う人だけ `pip install pymupdf`） |
| Real-ESRGAN `RealESRGAN_x4plus.pth` / spandrel | `tools/pano_upscale.py`（任意の高画質拡大） | BSD-3-Clause / MIT |
| Playwright | `tools/studio_check.py`（検査・スクリーンショット） | Apache-2.0 |
| ffmpeg | 動画スライドの書き出し・変換（任意） | LGPL / GPL（ビルドによる） |

## 見本の絵・スライド

`studio/assets/rooms/sample_*/` の背景・360° 画像は、このキットのために画像生成 AI（OpenAI Codex CLI の image_gen ツール）で
新しく作ったものです（プロンプトは `docs/prompts/`）。深度画像は Depth Anything V2 Small で生成しました。
`studio/assets/slides/sample/` は Pillow と ffmpeg で作った説明用のスライドです。これらはリポジトリの MIT ライセンスで配布します。
