// material_tune.js — VRM のマテリアルを実行時だけ補正する（VRM ファイルは書き換えない）＋揺れ物の抵抗を少し強める
//   規則は studio.config.json の character.materialRules（配列・先勝ち）から渡す。既定は空＝何もしない。
//   { "match": "_HAIR",               マテリアル名に対する正規表現（大文字小文字は無視）
//     "tint": [1, 0.9, 0.8],          color への乗算（linear RGB）
//     "shadeMul": [0.8, 0.7, 0.7],    MToon shadeColorFactor への乗算（陰色を深く＝影の段を見せる）
//     "shift": -0.05,                 MToon shadingShiftFactor の上書き（負＝陰の領域を広げる）
//     "hueDeg": -14,                  color / shade の色相を回す（度・HSL）
//     "texHueDeg": 14 }               baseMap のピクセル色相を回す（度・YIQ 回転なので符号は HSL と逆向きに効く）
//   ★スタジオの照明で詰めた色は、別の照明では違って見える（docs/troubleshooting.md）。見せる場所の照明で確かめること。
import * as THREE from 'three';

function shiftHue(col, deg) {
  const hsl = {};
  col.getHSL(hsl);
  const h = (((hsl.h * 360) + deg) % 360 + 360) % 360;
  col.setHSL(h / 360, hsl.s, hsl.l);
}

function rotHueTex(tex, deg) {
  if (!tex || !tex.image || tex.userData.hueShifted) return;
  const img = tex.image;
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const id = g.getImageData(0, 0, cv.width, cv.height);
  const d = id.data;
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  // YIQ 色相回転（彩度・明度を保つ回転）
  const m = [
    0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.497 * s,
    0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s,
    0.299 - 0.300 * c + 1.250 * s, 0.587 - 0.588 * c - 1.050 * s, 0.114 + 0.886 * c - 0.203 * s,
  ];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    d[i]     = m[0] * r + m[1] * gg + m[2] * b;
    d[i + 1] = m[3] * r + m[4] * gg + m[5] * b;
    d[i + 2] = m[6] * r + m[7] * gg + m[8] * b;
  }
  g.putImageData(id, 0, 0);
  const nt = new THREE.CanvasTexture(cv);
  nt.flipY = tex.flipY; nt.colorSpace = tex.colorSpace;
  nt.wrapS = tex.wrapS; nt.wrapT = tex.wrapT; nt.channel = tex.channel;
  nt.userData.hueShifted = true;
  return nt;
}

const mul = (col, f) => col && col.isColor && col.setRGB(col.r * f[0], col.g * f[1], col.b * f[2]);

// 揺れ物の暴れ対策 — スカート/髪の抵抗・重力を実行時に少し強める（VRMファイルは書き換えない）
//   ボーン名は VRoid 系命名（J_Skt_*=スカート, J_Hair*=髪）を想定しつつ広めにマッチ
export function tuneSprings(vrm) {
  const sbm = vrm && vrm.springBoneManager;
  if (!sbm || !sbm.springs) return [];
  const hit = [];
  for (const sp of sbm.springs) {
    for (const j of sp.joints || []) {
      const bn = (j.bone && j.bone.name) || '';
      const st = j.settings;
      if (!st) continue;
      if (/skt|skirt|dress|スカート/i.test(bn)) {          // スカート: 抵抗↑＋重力↑で跳ね上がりを抑える
        st.dragForce = Math.min(0.8, (st.dragForce ?? 0.4) * 1.5);
        st.gravityPower = (st.gravityPower ?? 0) * 1.3 + 0.05;
        hit.push(bn);
      } else if (/hair|髪/i.test(bn)) {                    // 髪: 抵抗を少しだけ強める
        st.dragForce = Math.min(0.8, (st.dragForce ?? 0.4) * 1.25);
        hit.push(bn);
      }
    }
  }
  return hit;
}

export function tuneMaterials(vrm, rules = []) {
  const compiled = (Array.isArray(rules) ? rules : []).filter(r => r && r.match).map(r => ({ ...r, re: new RegExp(r.match, 'i') }));
  const hit = [];
  if (!compiled.length) return hit;
  const done = new Set();
  vrm.scene.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const n = (m && m.name) || '';
      if (!m || done.has(m.uuid)) continue;
      const rule = compiled.find(r => r.re.test(n));
      if (!rule) continue;
      done.add(m.uuid);
      if (rule.tint && m.color) mul(m.color, rule.tint);
      if (rule.hueDeg && m.color) shiftHue(m.color, rule.hueDeg);
      if (rule.hueDeg && m.shadeColorFactor) shiftHue(m.shadeColorFactor, rule.hueDeg);
      if (rule.shadeMul && m.shadeColorFactor) mul(m.shadeColorFactor, rule.shadeMul);
      if (rule.shift !== undefined && 'shadingShiftFactor' in m) m.shadingShiftFactor = rule.shift;
      if (rule.texHueDeg) {
        const nt = rotHueTex(m.map, rule.texHueDeg);
        if (nt) m.map = nt;
      }
      m.needsUpdate = true;
      hit.push(n);
    }
  });
  return hit;
}
