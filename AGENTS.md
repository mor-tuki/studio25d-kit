# AGENTS.md — AI エージェント向け手順書

あなた（Claude Code / Codex などの AI エージェント）が、このリポジトリで **持ち主のための新しい部屋を一から作り、スタジオで動かす** ための手順です。
上から順に進め、各段の **合格条件（数）** を満たしてから次へ進んでください。「見た感じ大丈夫」は合格になりません（理由は [docs/troubleshooting.md](docs/troubleshooting.md) の 1・2）。

- 部屋の種類は 2 つ：**2.5D**（16:9 のイラスト 1 枚＋深度）と **360°**（2:1 の正距円筒パノラマ）。
- 触るのはデータだけ：`studio/assets/rooms/<id>/` の画像と `studio/rooms.json`（と必要なら `studio/moves.json`）。`studio/js/` は原則いじらない。
- 作業前に一度 `python tools/studio_check.py smoke` を通して、環境が動くことを確かめる（Chrome が 1 つ立ち上がり、最後に閉じる）。

---

## 0. 準備

```sh
python --version                          # 3.10+
pip install torch --index-url https://download.pytorch.org/whl/cpu   # Linux：GPU 不要なら先に CPU 版を（CUDA 版は数 GB）
pip install -r requirements.txt           # numpy Pillow torch transformers playwright
python -m playwright install chromium     # Google Chrome が入っていれば不要（Linux の同梱 Chromium は H.264 を再生できず、smoke の動画検査が skip になる）
python -B -m unittest discover -s studio/tests     # 24 tests OK
python tools/studio_check.py smoke                 # RESULT: PASS
```

- PDF からスライドを作る道具（`tools/pdf_to_slides.py`）を使うときだけ `pip install pymupdf`（AGPL-3.0・任意。requirements には入れていない）。
- 画像生成は持ち主が使える道具で行う（Codex CLI の `image_gen`、ChatGPT、Gemini、Stable Diffusion 等）。このキットの見本は Codex CLI で作った：
  `codex exec -s workspace-write --skip-git-repo-check "Read prompt.txt. Use the image_gen tool to generate ONE image following it, in the widest 16:9 landscape size available. Save the PNG to room.png." < /dev/null`
  （Windows では `< /dev/null` の代わりに `< NUL`。cmd ならそのまま、PowerShell は `<` を使えないので `cmd /c "codex exec ... < NUL"` で包む）
  （プロンプトはファイルに置いて読ませる。実際に使ったプロンプト＝ `docs/prompts/`）
- 部屋の `id` は英小文字・数字・`_` だけ（例 `my_library`）。素材は `studio/assets/rooms/<id>/` に置く。

---

## (a) 2.5D の部屋の絵を設計して生成する

視差がきれいに出る絵には条件がある。**プロンプトに必ず全部書く**。

### 構図のルール（なぜ必要か）

| ルール | 理由 |
|---|---|
| 16:9 横長・カメラは正面・目の高さ 1.5 m・一点透視 | スタジオは「正面から撮った写真」として奥行きを戻す。斜めの絵は奥行きが歪む |
| **手前・中景・奥** がはっきり分かれる（手前の隅に小さな物、中景に床、奥に壁） | 視差＝手前と奥のずれ。層が無いと動かしても平面に見える（`studio_parallax.py` で 15 px 未満） |
| **スクリーン（資料を映す面）は正面を向いた完全な長方形・16:9・一様な暗い色・縁がまっすぐ** | 長方形の 4 隅をそのまま座標にする。台形だとスライドが歪む。一様な暗色だと位置を自動検出できる |
| スクリーンは中央よりやや左（中心が左から 38〜40%）・幅は絵の 30〜38% | 話し手（キャラ）を右に、資料を左に置く構図を前提にプリセットを組んでいる |
| 右寄りの床（左から 70〜80%・下 1/3）に **何もない立ち位置** | キャラの足を置く。物があるとキャラが埋まる |
| **画面の外周 6% には主役を置かない**（壁・床・葉など単純なもの） | カメラは絵の内側しか映さないので外周は常に切れる。主役が端にかかると切れて見える |
| 人物・動物・文字・ロゴを一切入れない | 権利・ブランド・「誰かいる」違和感を避ける。スライド以外に文字を出さない |

### プロンプトの型（英語のまま使う。[ ] を差し替える）

```
Generate ONE background plate for a 2.5D virtual streaming stage (a single illustration that will later be turned
into a depth map and viewed with a slightly moving camera for parallax).

SCENE: [場所・時間帯・素材・色・置く物を 3〜5 行で。例: a quiet library at dusk, dark walnut shelves, green banker lamps]

COMPOSITION (most important):
- Wide 16:9 landscape. Camera straight-on, eye height about 1.5 m, horizon around 45% from the top, symmetric one-point perspective.
- A flat, front-facing, PERFECT RECTANGLE screen with a 16:9 aspect ratio hangs on the back wall, centered-left
  (its center about 38% from the left edge), occupying about 34% of the image width, with a thin [frame material] frame.
  The screen surface is a FLAT, UNIFORM dark charcoal gray. Its edges must be straight and crisp, not a trapezoid.
- An EMPTY standing spot on the floor to the RIGHT of the screen (about 72-78% from the left, lower third), clear of objects.
- Clear depth layering: FOREGROUND ([小さな物] at the bottom-left corner and [小さな物] at the bottom-right corner,
  small, not covering the middle), MIDGROUND (the floor and the standing spot), BACKGROUND (back wall with the screen).
- Keep a calm margin at all four image edges: the outer 6% of the image should be simple wall, floor or soft foliage.
- [画風: painterly anime background art / watercolor / photoreal ...], [palette].

ABSOLUTELY NO people, NO characters, NO silhouettes, NO animals, NO text, NO letters, NO numbers, NO logos, NO watermark.
```

### 生成後のチェック（目で見る＋数える）

1. 画像を開いて見る：人・文字・ロゴが無い／スクリーンが長方形／立ち位置が空いている。どれか欠けたら作り直す（直すより作り直しが速い）。
2. スクリーンの 4 隅を数で取る（暗い一様面の検出）。`ROWS`＝暗い行を探す横の範囲、`COLS`＝暗い列を探す横の範囲（絵の幅に対する割合）。
   **2.5D は `ROWS=(.25,.5)` / `COLS=(.1,.7)`、360° は `ROWS=(.4,.6)` / `COLS=(.3,.7)`**（スクリーンが絵の横中央にあるため）。
   `SIZE` には rooms.json の `width, height`（座標系）を入れる。画像がそれと違う大きさなら縮めてから測る：

```python
import numpy as np; from PIL import Image
PATH, SIZE = "studio/assets/rooms/<id>/bg.jpg", (1672, 941)   # 360° なら pano_4k.jpg と (width, height)
ROWS, COLS = (.25, .5), (.1, .7)                               # 360° なら (.4, .6), (.3, .7)
im = Image.open(PATH).convert("L")
if im.size != SIZE: im = im.resize(SIZE, Image.LANCZOS)
a = np.asarray(im).astype(int); m = a < 80; H, W = a.shape
rows = [y for y in range(H) if m[y, int(W*ROWS[0]):int(W*ROWS[1])].mean() > .9]
cols = [x for x in range(int(W*COLS[0]), int(W*COLS[1])) if rows and m[min(rows):max(rows), x].mean() > .9]
if not rows or not cols:
    raise SystemExit("暗い一様面が見つからない：ROWS/COLS を絵のスクリーン位置に合わせるか、しきい値 80 を上げる（スクリーンが明るすぎるなら作り直し）")
y0, y1, x0, x1 = min(rows), max(rows), min(cols), max(cols); w = (y1 - y0) * 16 / 9; cx = (x0 + x1) / 2
print("dark  x", x0, x1, "y", y0, y1)
print("16:9  x", round(cx - w / 2), round(cx + w / 2), "y", y0, y1)   # これを screen の 4 隅にする
```

   見本での結果：2.5D アトリエ＝暗い面 x 349〜939・y 147〜442 → 16:9 で **x 382〜906**（rooms.json と一致）。360° 温室＝ 16:9 で x 741〜1032・y 288〜452（rooms.json の 739〜1034 / 286〜452 と ±2 px。rooms.json は元画像で測った値）。
   暗い面が 16:9 でなければ、高さに合わせて **左右を内側に詰めた 16:9 の矩形** を `screen` にする（残りの暗い帯は枠の一部に見える。上の `16:9` 行がそれ）。
3. 保存：`bg.jpg`（JPEG 品質 90・長辺 1600〜2048 px で十分）と `thumb.jpg`（640×360）。

```sh
python -c "from PIL import Image; im=Image.open('room.png').convert('RGB'); im.save('studio/assets/rooms/<id>/bg.jpg', quality=90, optimize=True); im.resize((640,360)).save('studio/assets/rooms/<id>/thumb.jpg', quality=85)"
```

---

## (b) 360° の部屋（正距円筒パノラマ）を生成する

### プロンプトの型

```
Generate ONE seamless 360-degree EQUIRECTANGULAR panorama image (exact 2:1 aspect ratio, full 360 x 180 degrees),
for use as a spherical environment texture viewed from the inside of a sphere.

PROJECTION RULES (most important):
- true equirectangular projection: the horizon is a perfectly straight horizontal line at exactly half height
- the LEFT edge and the RIGHT edge must connect seamlessly (the same content continues across the seam)
- the top row is the zenith (ceiling directly above), the bottom row is the nadir (floor directly below),
  stretched horizontally as in a real equirectangular photo
- vertical lines (pillars, window frames) stay vertical; no fisheye circle, no border, no frame, no vignette

SCENE: the inside of [部屋], seen from the center of the room at standing eye height (about 1.6 m), [時間帯].
- one direction (the CENTER of the image): a flat, front-facing large blank wall screen in a thin frame,
  the screen surface a FLAT UNIFORM dark charcoal gray
- around the room: [周りの物]; furniture placed near the walls (not near the center)
- above: [天井]
- below: [床], simple and evenly lit, with a wide EMPTY open area in the middle of the room
- palette: [色]. [画風]

NO people, NO characters, NO animals, NO text, NO letters, NO logo, NO watermark.
```

- 床は **単純で均一** に（模様の強い床は、床に投影したとき放射状に歪んで見える）。家具は **壁際**（部屋の中央に物があると、床への投影で引き伸ばされる）。
- スクリーンは **絵の横中央**（u = 0.5）に置かせる。初期カメラはそこを向く（`pano.centerU`）。

### 検査と整え（必須）

```sh
python tools/pano_prep.py pano.png studio/assets/rooms/<id>
```

| 出力 | 合格 |
|---|---|
| `CHECK aspect 2:1` | **PASS 必須**（2.00 ±0.01）。違えば作り直し |
| `CHECK seam ratio <= 3.0` | PASS。WARN なら `--xfade 20〜40` で再実行、それでも目立てば作り直し |
| `poleSpread.zenith / nadir` | 40 以下が目安。超えたら `--zenith-band 0.09`（天頂のくさび対策）か作り直し |
| `suggest.pano.radius` | rooms.json の `pano.radius` の初期値に使う |

出力：`pano_4k.jpg`（4096×2048・継ぎ目を寄せ、極を均し、左右を巻き込んで拡大）、`thumb.jpg`、`light.json`（照明色の目安）、`stats.json`。

`light.json` → rooms.json の `lighting` への写し方（キャラ用の光。背景には効かない）：

| light.json | rooms.json | 写し方 |
|---|---|---|
| `ground`（下半分の平均色） | `lighting.hemi.ground` | そのまま |
| `hot`（最も明るい 1.5% の画素の平均色） | `lighting.rim.color` | そのまま（窓・照明の色が輪郭光になる） |
| `sky`（上半分の平均色） | `lighting.hemi.sky` | **目で調整**。上半分は壁や葉も含むので暗く濁りやすい。少し明るく・空や天井の色味へ寄せる（見本：`#8D9D90` → `#C9D8E6`） |
| `meanLum` | — | 参考値（`exposure` の目安。0.6 前後なら既定 1.0 のまま） |
8K で細部が欲しいときだけ `tools/pano_upscale.py`（Real-ESRGAN・任意）。

スクリーン矩形は 2.5D と同じ要領で、パノラマの元画像の座標で取る（16:9 に詰める）。

---

## (c) 深度画像（rg16）を作る — 2.5D の部屋だけ

```sh
python tools/make_depth.py studio/assets/rooms/<id>/bg.jpg studio/assets/rooms/<id> --preview
```

- 中身：Depth Anything V2 **Small**（Apache-2.0）を transformers で CPU 実行（1672×941 で約 10 秒・初回はモデル約 100MB をダウンロード）。
  `predicted_depth`（float）を元サイズへ双三次補間 → 1〜99 パーセンタイルで 0..1 に正規化 → 16bit。
- 形式 **rg16**：R = 上位 8bit、G = 下位 8bit、B = 0 の RGB PNG。**値は 1 = 手前・0 = 奥**。engine は `(R*256+G)/65535` で読む。
- 出力：`depth_rg.png`（スタジオが読む）、`depth16.png`（確認用。**コミットしない**＝`rm` してよい）、`depth_preview.png`（`--preview`。確認後は消す）。どちらも `.gitignore` 済み。
- 合格：スクリプトが `WARNING`（下＝床が上＝奥より遠いと推定）を出さないこと。`depth_preview.png` を見て、**床が下ほど白い・手前の物が白い・奥の壁が黒い** こと。良い例＝見本の [`docs/images/sample_atelier_depth_preview.png`](docs/images/sample_atelier_depth_preview.png)。
- **注意（来歴の正直な記録）**：作者が本番で使っていた深度も Depth Anything V2 Small＋1〜99 パーセンタイル正規化＋rg16 だが、当時は transformers の pipeline が返す 8bit の `depth` 画像を 16bit に引き伸ばしていた。このキットは同じモデルの float 出力を使うので、段差が出にくい（結果は少しなめらか）。
- **360° の部屋は深度を使わない**（球＋床への投影で立体感を出す）。360° に `make_depth.py` をかける必要はない。

---

## (d) rooms.json に登録する

`studio/rooms.json` は配列。**見本の 2 件をコピーして id・パス・座標を直す** のが一番安全。`neighbours` は片側に書けば双方向の扉になる（`E` の行き先・移動演出の組み合わせ）。

### 2.5D の部屋（`type` を書かない）

| フィールド | 意味・決め方 |
|---|---|
| `id` / `name` / `subtitle` | 識別子 / 部屋カードの表示名 / 小さい英字の副題 |
| `background` / `thumb` | 絵（jpg/png）/ 部屋カードの画像 |
| `depth`, `depthMode` | `depth_rg.png` のパス / `"rg16"`（説明用） |
| `width`, `height` | **座標系**。`screen` や `actor.foot` を測ったときの絵のピクセルサイズ。テクスチャの実解像度とは独立（あとで高解像度の絵に差し替えても座標はそのまま） |
| `referenceFov` | 絵を「撮った」カメラの縦画角（度）。通常 **40**。奥行きを戻す計算に使う |
| `screenWidth` | スクリーンの実幅（m）。これで部屋全体の大きさ（スクリーンまでの距離 screenZ）が決まる。**2.8〜3.2** |
| `depthRange` `{zmin, zmax}` | 深度 → 距離の写像。距離 ∝ zmin＋(1−d)(zmax−zmin) を、スクリーン面がちょうど screenZ になるよう伸縮。**比 zmax/zmin が視差の強さ**。既定 4.0 / 10.8 |
| `depthAmplitude` | `depthRange` が無いときだけ使う線形の写像の強さ（予備） |
| `screen` | スクリーンの 4 隅 `[[左上],[右上],[右下],[左下]]`（px・width/height の座標系）。この面は奥行きを平らにされ、スライドが貼られる |
| `screenClamp` `{left,right,top,bottom}` | スクリーン周り（px）を「スクリーンより手前に出さない」帯。スライド前に深度の山（黒い突起）が出るのを防ぐ。下は広め（120〜150） |
| `actor.foot` / `actor.spots` | キャラの足の位置 a（px・床の上）/ 歩行の行き先 a・b・c（b＝資料の横、c＝目印の下が慣例） |
| `actor.height` / `actor.yawDeg` | キャラの身長（m）/ 体の向き（度。負＝少し左＝資料側を向く） |
| `anchors.lookup` / `anchors.rim` | 「見上げる」歩行の目印（px）/ リムライトの位置（px） |
| `lighting` | キャラ用の光（背景には効かない）。`key`（主光・影）・`fill`（補助の点光源）・`rim`（輪郭の逆光：`anchor` 名か `offset` m）・`hemi`（空と地面の色） |
| `camera.fov` | 出力の縦画角。**referenceFov より小さく**（例 34 < 40）。この差がカメラの動ける余白になる |
| `camera.yaw/pitch/x/y/dolly/zoom` | 各軸の可動域 `[min, max]`。単位：度・度・m・m・m（前進）・度（画角を狭める） |
| `camera.presets` | `wide`（全景・既定 `{}`）・`presenter`（話し手）・`screen`（資料）。入力空間のオフセット |
| `camera.follow` | 歩行中にカメラがキャラを追う割合 |
| `camera.sway` | 待機ゆらぎ（x・y の平行移動の振幅 m と周期 秒）。視差を常に少し見せる |
| `transition.approach / emerge` | 部屋移動の「寄り」と「引き」の形（入力空間） |
| `exposure` | （任意）部屋ごとのトーンマップ露出。既定 1.0 |

### 360° の部屋（`"type": "pano360"`）

| フィールド | 意味・決め方 |
|---|---|
| `background` / `backgroundSmall` | 高解像度 / 予備（GPU の最大テクスチャが 8192 未満なら予備を使う）。4K だけなら両方同じでよい |
| `width`, `height` | パノラマ元画像の座標系（スクリーン・目印を測った画像のサイズ） |
| `pano.height` | 撮影点の高さ（m）。大きいほど床が広く・部屋が大きく見える。1.6〜2.2 |
| `pano.radius` | 床が壁へ立ち上がる距離（m）。`pano_prep.py` の `suggest` から始めて、壁の根元が床に流れて見えたら小さく、部屋が狭苦しければ大きく |
| `pano.centerU` | 初期カメラが向く横位置（0..1）。スクリーンを中央に描かせたなら 0.5 |
| `pano.resolution` | （任意）球（`GroundedSkybox`）の分割数。既定 160。床と壁の境目がカクついて見えるときだけ上げる |
| `screen` | パノラマ上のスクリーン矩形（px）。同じ球面の切れ端にスライドを貼る |
| `actor.spots` | 床の **m 座標** `[x, z]`（px ではない）。a は撮影点のほぼ真下 `[0, 0.2]` |
| `anchors.*` | パノラマ上の px。`lighting.anchorDistance`（m）の距離に置く |
| `camera.fov` | 360° は広め（50〜60）にするとスクリーンが大きくなりすぎない |
| `camera.orbit` | `distance`（注視点からの距離 m）・`height`（カメラの高さ）・`focusHeight`（注視点の高さ）・`aside`（注視点を横にずらす m）・`maxRadiusRatio`（カメラが出てよい半径の割合） |
| `camera.yaw` | 360° は `[-360, 360]`（一周回れる）。`pitch` の上限は天頂の歪みが見えない値（40〜52） |

---

## (e) 検証する（全部「数」で）

サーバーは自動で立ち上げ・終了させる（`--serve`）。Chrome はヘッドレスで 1 つだけ。持ち主が 8811 で配信・作業中なら `--port 8812` など別のポートを付ける（検査が本番のスタジオを操作しないように）。

| コマンド | 合格条件 |
|---|---|
| `python -B -m unittest discover -s studio/tests` | OK |
| `python tools/studio_check.py coverage --serve` | **`max=0px` かつ `exhaustive=True` かつ negative control `alive: True` かつ pageerror 0** |
| `python tools/studio_parallax.py --room <id>` | near−far が **30〜70 px**（参考：作者の本番 2 部屋 53・55 px、見本 60 px） |
| `python tools/studio_check.py pano --serve` | 継ぎ目 `ratio <= 1.5` が床・壁・天井の 3 枚とも。天頂・天底の画像（`output/shots/pano_pole_*`）を開いて渦・くさびが無いこと |
| `python tools/studio_check.py shots --serve` | `output/shots/<id>_{wide,presenter,screen}.png` を **開いて見る**：資料プリセットでスライド全体が収まる・全景で主役が切れていない |
| `python tools/studio_check.py smoke` | `RESULT: PASS`（全部屋 0px・動画スライドの currentTime が進む・一時停止が効く）。撮影は `output/shots/smoke_*.jpg`（`--docs` で `docs/images/` を更新）。H.264 を再生できないブラウザ（Linux の Playwright 同梱 Chromium など）では動画検査は `skipped: no H.264 decoder` になり、失敗にはしない |

### coverage（マゼンタ検査）が何を数えているか

- 背景メッシュだけを白、それ以外をマゼンタで 1920×1080 に描き、**G < 254 の画素を全部数える**。キャラ・スライド・暗転はこのパスに入らないので、穴を隠して合格になることはない。
- 対象：全部屋 × プリセット 3 × カメラ 6 軸の上下限 64 通り＋中央、全ての隣の部屋への移動（60fps の全フレーム）、moves.json の全ムーブ（30fps）、待機ゆらぎ。
- 陰性対照：クランプを外して yaw を +12° 振った絵で **必ず露出が出る** ことを確かめる（検出器が死んでいないことの証明）。
- 不合格のとき：`firstFailures` の部屋・プリセットを見て、その部屋の `camera` の可動域を狭めるか、`camera.fov` を下げる。**可動域を変えたら必ず再実行**（前回の 0px は変更後の証明にならない）。

---

## (f) カメラムーブを足す（`studio/moves.json`）

```json
{"name": "slow_push", "label": "ゆっくり寄る", "key": "Shift+1",
 "keys": [{"t": 0, "cam": "@base"}, {"t": 6, "cam": "@presenter"}]}
```

| フィールド | 意味 |
|---|---|
| `keys` | キーフレーム `{t: 秒, cam: 入力}`。`cam` は `{yaw,pitch,x,y,dolly,zoom}`（書かない軸は 0＝全景）、`"@presenter"` 等（その部屋のプリセット）、`"@base"`（押した時のカメラ） |
| `key` | `"Shift+1"`〜`"Shift+0"` か 1 文字（数字単独は部屋選択なので使わない。既存：B X P K O U T M A Q W R E G H F I） |
| `ease` | 省略＝ease-in-out（3 次）。`"sine"`＝穏やか（一周もの向き） |
| `loop` / `dur` / `wave` | ループ / 長さ / 呼吸型の揺れ `{"x": [[振幅, 周期秒, 位相], ...]}` |
| `waveOffset` | （`wave` と一緒に・任意）軸ごとの一定のずらし `{"dolly": 0.022}`。揺れの中心を開始カメラからずらす。可動域の内側へ寄せる計算にも含まれる |
| `roomTypes` | `["pano360"]` なら 360° の部屋だけ（2.5D 部屋では押せない） |
| `rooms` | `{"<id>": false}` でその部屋だけ無効、`{"<id>": {"keys": [...]}}` で部屋ごとに差し替え |
| `kind: "walk"` + `steps` | キャラの歩行（`["walk","b"]`・`["face","slide"|"lookup",秒]`・`["gest","point"|"lookup",秒]`・`["turn","front"]`・`["hold",秒]`） |
| `end`（walk） | 歩き終わったときに立っている spot（`"a"`・`"b"`・`"c"`）。サーバーが次の歩行の出発点（`walkSpot`）として覚える。省略すると今の spot のまま |
| `maxSeconds`（walk） | 歩行の最長時間（秒）。この間は次の歩行を受け付けない（`walk_busy`）。**0 < x ≤ 120**（範囲外はサーバーが `invalid_moves` で拒否）。省略時 20。`steps` の合計より少し長めに |
| `auditFrom`（walk） | coverage 検査でこの歩行を始める spot の一覧。省略時 `["a"]`。a 以外から歩き出す歩行（例 `goto_a` は `["b", "c"]`）に書く |

ムーブの値は **必ず幾何クランプを通る** ので、2.5D で範囲外の値を書いても絵の外は映らない（その代わり、端で動きが止まって見える）。足したら `coverage` を再実行（ムーブも全フレーム検査対象）。

---

## 完了の報告に含めるもの

1. 追加した部屋の id・種類、使ったプロンプト（`docs/prompts/<id>.txt` に保存）と生成に使った道具
2. 上の (e) の表の各コマンドの結果の数（coverage の max・count/expected、視差 px、継ぎ目 ratio、smoke の RESULT）
3. 撮れたスクリーンショットのパス（`output/shots/`。README 用に差し替えるなら `smoke --docs` で `docs/images/`）
4. 目で見て気になった点（あれば正直に。数が合格でも見た目が悪いことはある）

## やってはいけないこと

- 実在の人物・キャラクター・ロゴ・既存作品の背景に似せた絵を作る／持ち主の許可なく公開リポジトリに入れる
- 他人の VRM をコミットする（`*.vrm` は `.gitignore` 済み）
- 検査を飛ばして「動きました」と報告する。縮小画像を目で見ただけの確認を「確認済み」と書く
- サーバーを 0.0.0.0 で公開する（このサーバーは 127.0.0.1 専用の設計）
