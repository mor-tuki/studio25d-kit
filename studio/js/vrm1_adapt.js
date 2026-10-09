// vrm1_adapt.js — VRM 1.0 モデルを、VRM 0.x 前提で組んだスタジオでそのまま動かす橋渡し。
//  three-vrm では VRM 1.0 は VRM 0.x と Y 軸まわりに π 反対を向く。スタジオの姿勢コード（腕 z=±1.15・脚の振り・
//  scene.rotation.y=π+yaw・頭のカメラ目線）は VRM 0.x の正規化ボーンの向きで書かれているので、
//   (1) 中身を内側の Group で π 回す（scene.rotation.y の意味を旧モデルと同じにする）
//   (2) 正規化ボーン → 生ボーンへ移す瞬間だけ、回転を Ry(π) で共役（x,z を反転・y はそのまま）、hips の移動量も x,z 反転
//  とする。姿勢コード側の値は書き換えない（移したあとで元に戻す）。VRM 0.x では何もしない。
//  外すとき：engine.js の adaptVrm1(this.vrm) の 1 行を消す。
import * as THREE from 'three';

const SKIP = new Set(['leftEye', 'rightEye']);   // 目は lookAt が VRM 1.0 の向きで直接書く

export function adaptVrm1(vrm) {
  if (!vrm || !vrm.meta || vrm.meta.metaVersion !== '1') return false;
  const scene = vrm.scene;
  const inner = new THREE.Group(); inner.name = 'Vrm1Flip'; inner.rotation.y = Math.PI;
  for (const child of [...scene.children]) inner.add(child);
  scene.add(inner);
  scene.updateMatrixWorld(true);

  const humanoid = vrm.humanoid;
  const bones = [];
  for (const name of Object.keys(humanoid.humanBones || {})) {
    if (SKIP.has(name)) continue;
    const node = humanoid.getNormalizedBoneNode(name);
    if (node) bones.push(node);
  }
  const hips = humanoid.getNormalizedBoneNode('hips');
  const hipsRest = hips ? hips.position.clone() : null;
  const saved = bones.map(() => new THREE.Quaternion());
  const savedHips = new THREE.Vector3();
  const orig = humanoid.update.bind(humanoid);
  humanoid.update = () => {
    for (let i = 0; i < bones.length; i++) {
      const q = bones[i].quaternion; saved[i].copy(q);
      q.set(-q.x, q.y, -q.z, q.w);                   // Ry(π)·q·Ry(π)⁻¹
    }
    if (hips) { savedHips.copy(hips.position); hips.position.set(2 * hipsRest.x - hips.position.x, hips.position.y, 2 * hipsRest.z - hips.position.z); }
    try { orig(); } finally {
      for (let i = 0; i < bones.length; i++) bones[i].quaternion.copy(saved[i]);
      if (hips) hips.position.copy(savedHips);
    }
  };
  return true;
}
