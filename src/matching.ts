/**
 * hunk 身份与匹配策略（纯函数，零依赖可测）。
 *
 * 匹配策略：
 * 1. 内容哈希优先：hunk 身份 = sha256(路径 + ± 行，剥 \r)，不含上下文，
 *    因此上下文移动/相邻无关编辑不影响身份。同哈希碰撞按距当前 hunk 的
 *    oldStart 最近者贪心消解。
 * 2. 位置回退：按 oldStart 保序贪心；窗口 |ΔoldStart| ≤ max(20, 0.2×hunk 行数)
 *    且行区间重叠 ≥50%；候选不唯一判为未分配（不硬配）。
 */
import { hunkId, Hunk } from './diffParser';

export interface StoredHunk {
  id: string;
  oldStart: number;
  oldLines: number;
}

export interface MatchResult {
  /** 与 current 平行的匹配结果：每个当前 hunk 匹配到的 stored 记录（或 null） */
  owners: (StoredHunk | null)[];
  /** 匹配成功后建议回写的位置（让 stored 记录跟随当前 hunk 的最新位置） */
  updates: { id: string; oldStart: number; oldLines: number }[];
}

export function matchFileHunks(current: Hunk[], stored: StoredHunk[]): MatchResult {
  const owners: (StoredHunk | null)[] = new Array(current.length).fill(null);
  const updates: { id: string; oldStart: number; oldLines: number }[] = [];
  const used = new Set<StoredHunk>();
  const byId = new Map<string, StoredHunk[]>();
  for (const s of stored) {
    const arr = byId.get(s.id) ?? [];
    arr.push(s);
    byId.set(s.id, arr);
  }

  // pass 1：内容哈希匹配
  for (let i = 0; i < current.length; i++) {
    const c = current[i];
    const candidates = (byId.get(c.id) ?? []).filter((s) => !used.has(s));
    if (candidates.length === 0) {
      continue;
    }
    candidates.sort(
      (a, b) => Math.abs(a.oldStart - c.oldStart) - Math.abs(b.oldStart - c.oldStart),
    );
    const s = candidates[0];
    used.add(s);
    owners[i] = s;
    updates.push({ id: s.id, oldStart: c.oldStart, oldLines: c.oldLines });
  }

  // pass 2：位置回退
  const remaining = stored.filter((s) => !used.has(s));
  for (let i = 0; i < current.length; i++) {
    if (owners[i]) {
      continue;
    }
    const c = current[i];
    const window = Math.max(20, Math.round(0.2 * Math.max(c.oldLines, 1)));
    const candidates = remaining.filter((s) => {
      if (Math.abs(s.oldStart - c.oldStart) > window) {
        return false;
      }
      return overlapRatio(c, s) >= 0.5;
    });
    if (candidates.length === 1) {
      const s = candidates[0];
      used.add(s);
      owners[i] = s;
      updates.push({ id: s.id, oldStart: c.oldStart, oldLines: c.oldLines });
    }
    // 0 个或 >1 个候选：保持未分配，不硬配
  }

  return { owners, updates };
}

function overlapRatio(c: Hunk, s: StoredHunk): number {
  const cEnd = c.oldStart + Math.max(0, c.oldLines - 1);
  const sEnd = s.oldStart + Math.max(0, s.oldLines - 1);
  const cLen = cEnd - c.oldStart + 1;
  const sLen = sEnd - s.oldStart + 1;
  const overlap = Math.max(0, Math.min(cEnd, sEnd) - Math.max(c.oldStart, s.oldStart) + 1);
  const denom = Math.max(cLen, sLen);
  return denom === 0 ? 0 : overlap / denom;
}
