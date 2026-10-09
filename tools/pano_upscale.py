# pano_upscale.py —（任意・高画質版）正距円筒パノラマを Real-ESRGAN x4 (spandrel・CPU) で拡大する
#   通常は tools/pano_prep.py（Lanczos 拡大）で十分。8K で細部まで欲しいときだけ使う。
#   準備: pip install spandrel torch ／ RealESRGAN_x4plus.pth（BSD-3-Clause・xinntao/Real-ESRGAN の Releases）を
#         tools/models/ に置くか、環境変数 ESRGAN_MODEL にパスを入れる
#   python tools/pano_upscale.py <src.png> <out_dir> [xfade_px=6] [zenith_band=0.0]
#   CPU で 1 枚 約 3 分。
#   xfade_px: 継ぎ目の左右を何 px かけて互いへ寄せるか（継ぎ目が目立つ絵は 40）
#   zenith_band: 天頂側の何割の行を「極に近いほど強い横方向の巡回ぼかし」で均すか（天頂がくさび状に割れる絵は 0.09）
#   出力: <out_dir>/pano_8k.jpg (8192x4096) / pano_4k.jpg (4096x2048 予備) / stats.json
# 継ぎ目対策: 左右に WRAP px 巻き込んで拡大 → 切り戻す。タイルは OVL px 重ねて境目を出さない。
import os, sys, json
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
import numpy as np
from PIL import Image
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get('ESRGAN_MODEL') or os.path.join(HERE, 'models', 'RealESRGAN_x4plus.pth')
SRC, OUTDIR = sys.argv[1], sys.argv[2]
os.makedirs(OUTDIR, exist_ok=True)
WRAP, TILE, OVL = 48, 384, 16
FINAL = (8192, 4096)
torch.set_num_threads(max(1, os.cpu_count() - 2))

from spandrel import ModelLoader
model = ModelLoader().load_from_file(MODEL)
model.eval().cpu()

src = np.array(Image.open(SRC).convert('RGB')).astype(np.float32)
H, W, _ = src.shape

def seam_stats(a):
    a = a.astype(np.float32)
    return float(np.abs(a[:, 0] - a[:, -1]).mean()), float(np.abs(a[:, 1:] - a[:, :-1]).mean())

stats = {'src': SRC, 'size': [W, H], 'seam_before': seam_stats(src)}

# 1) 継ぎ目の軽いクロスフェード（左右 6px を互いへ寄せる）
K = int(sys.argv[3]) if len(sys.argv) > 3 else 6
ZB = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
stats['xfade'] = K; stats['zenith_band'] = ZB
img = src.copy()
for i in range(K):
    w = 0.5 * (1 - i / K)
    l, r = src[:, i].copy(), src[:, W - 1 - i].copy()
    img[:, i] = l * (1 - w) + r * w
    img[:, W - 1 - i] = r * (1 - w) + l * w
# 2) 極の均し（天頂/天底の行を行平均へ。極の数 % の行で 1→0 に減衰）
P = max(4, int(H * 0.012))
for i in range(P):
    w = (1 - i / P) ** 2
    for row in (i, H - 1 - i):
        img[row] = img[row] * (1 - w) + img[row].mean(0, keepdims=True) * w
# 2b) 天頂帯の横ぼかし（行ごとに半径を変えた巡回ボックスぼかし。正距円筒では極ほど横が詰まるので物理的にも妥当）
if ZB > 0:
    Z = int(H * ZB)
    for row in range(Z):
        k = (1 - row / Z) ** 2
        r = int(W * 0.06 * k)
        if r < 1: continue
        line = img[row]
        c = np.cumsum(np.concatenate([line[-r - 1:], line, line[:r]], 0), 0)
        img[row] = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
stats['seam_prepped'] = seam_stats(img)

# 3) 左右巻き込み
pad = np.concatenate([img[:, -WRAP:], img, img[:, :WRAP]], axis=1) / 255.0
t = torch.from_numpy(pad).permute(2, 0, 1).unsqueeze(0)
_, C, h, w = t.shape
out = torch.zeros(1, C, h * 4, w * 4)
with torch.no_grad():
    for y0 in range(0, h, TILE):
        for x0 in range(0, w, TILE):
            ya, xa = max(0, y0 - OVL), max(0, x0 - OVL)
            yb, xb = min(h, y0 + TILE + OVL), min(w, x0 + TILE + OVL)
            o = model(t[:, :, ya:yb, xa:xb])
            cy, cx = (y0 - ya) * 4, (x0 - xa) * 4
            th, tw = (min(h, y0 + TILE) - y0) * 4, (min(w, x0 + TILE) - x0) * 4
            out[:, :, y0 * 4:y0 * 4 + th, x0 * 4:x0 * 4 + tw] = o[:, :, cy:cy + th, cx:cx + tw]
            print('tile', y0, x0, flush=True)
o = out.squeeze(0).permute(1, 2, 0).clamp(0, 1).numpy()
o = o[:, WRAP * 4: WRAP * 4 + W * 4]          # 切り戻し
up = Image.fromarray((o * 255 + 0.5).astype(np.uint8))
stats['x4'] = list(up.size)
big = up.resize(FINAL, Image.LANCZOS)
big.save(os.path.join(OUTDIR, 'pano_8k.jpg'), quality=92, subsampling=0)
big.resize((4096, 2048), Image.LANCZOS).save(os.path.join(OUTDIR, 'pano_4k.jpg'), quality=92, subsampling=0)
stats['final'] = list(FINAL)
stats['seam_after'] = seam_stats(np.array(big))
json.dump(stats, open(os.path.join(OUTDIR, 'stats.json'), 'w'), indent=1)
print(json.dumps(stats))
