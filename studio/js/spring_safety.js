// spring_safety.js — 揺れ物（髪・スカートの物理）の安全装置
//   step(dtRaw): 時間の空白が GAP_RESET を超えたら初期姿勢へ戻し、物理に渡す dt は DT_MAX で頭打ち
//   reset():     springBoneManager.reset()
//   settle(n,t0): applyCharPose を回しつつ vrm.update(1/60) を n 回（小さい固定 delta で沈める）
// 呼ぶ場所：部屋切替直後（暗転の底）・プリセットの瞬間カット・visibilitychange・撮影/検査の直前。
export const DT_MAX = 1 / 30;
export const GAP_RESET = 0.5;

export function createSpringSafety(getVrm, applyCharPose, log = () => {}) {
  let resets = 0;
  function reset() {
    const vrm = getVrm();
    const sbm = vrm && vrm.springBoneManager;
    if (sbm && sbm.reset) {
      try { sbm.reset(); resets++; } catch (e) { log('springReset ' + e.message); }
    }
  }
  function settle(steps = 120, t0 = 0) {
    const vrm = getVrm();
    if (!vrm) return;
    reset();
    for (let i = 0; i < steps; i++) {
      applyCharPose(t0 + i / 60);
      vrm.update(1 / 60);
    }
  }
  function step(dtRaw) {
    if (!(dtRaw >= 0)) dtRaw = 0;
    if (dtRaw > GAP_RESET) reset();
    return Math.min(dtRaw, DT_MAX);
  }
  return { reset, settle, step, get resets() { return resets; } };
}
