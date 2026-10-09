// idle_motion.js — §9 段階3-3: 待機モーション（呼吸・視線・まばたき・首振りは控えめ）
// 使い方: const idle = createIdleMotion(vrm, camera);  ループで idle.update(t)
// 注意: update(0) は「無垢な正面ポーズ」に収まること（検収 shot は t=0 で固定して撮る）
import * as THREE from 'three';

export function createIdleMotion(vrm, camera, { lookAtCamera = true } = {}) {
  const gaze = new THREE.Object3D();
  gaze.name = 'IdleGazeTarget';
  if (vrm.lookAt) vrm.lookAt.target = gaze;   // VRM0 は lookAt blendshape 経由で目線が動く

  const bone = n => vrm.humanoid.getNormalizedBoneNode(n);
  const _hp = new THREE.Vector3();

  function update(t) {
    // 呼吸（hips の rest 位置への加算——ローカル座標そのものに代入すると沈む）
    const hips = bone('hips');
    if (hips) {
      if (hips.userData.restY === undefined) hips.userData.restY = hips.position.y;
      hips.position.y = hips.userData.restY + Math.sin(t * 1.6) * 0.006;
    }
    // 首振りは控えめ（0.24→0.12・§9 3-3）、微かな頷きを足す
    const head = bone('head');
    if (head) {
      // カメラ目線（studio.config.json character.lookAtCamera）：首を 6 割だけカメラへ向け、揺れは小さく残す
      let face = 0;
      if (camera && lookAtCamera) {
        head.getWorldPosition(_hp);
        const want = Math.atan2(-(camera.position.x - _hp.x), -(camera.position.z - _hp.z)); // 前向き(-Z)基準の yaw
        let d = want - vrm.scene.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        face = THREE.MathUtils.clamp(d * 0.6, -0.35, 0.35);
      }
      head.rotation.y = face + Math.sin(t * 0.35) * 0.04;
      head.rotation.x = Math.sin(t * 0.21 + 0.7) * 0.02;
    }
    const spine = bone('spine');
    if (spine) spine.rotation.y = Math.sin(t * 0.35) * 0.03;

    // 視線＝基本はカメラへ、ゆっくり小さく揺らぐ（凝視しすぎない）
    if (vrm.lookAt && camera && lookAtCamera) {
      gaze.position.set(                                  // カメラ目線：揺らぎはごく小さく
        camera.position.x + Math.sin(t * 0.13) * 0.04,
        camera.position.y + Math.sin(t * 0.07 + 1.3) * 0.02,
        camera.position.z);
    }
    // まばたき（短く鋭い瞬きを ~2.3s 周期で）
    if (vrm.expressionManager) {
      vrm.expressionManager.setValue('blink', Math.max(0, Math.sin(t * 2.7)) ** 32);
      vrm.expressionManager.update();
    }
  }
  return { update, gaze };
}
