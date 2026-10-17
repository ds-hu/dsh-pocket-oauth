/**
 * test/netem.mjs: 可编程弱网 TCP 代理模拟器（阶段 2）
 *
 * 用于在纯 Node.js 测试环境中可复现地模拟真实手机弱网与隧道故障：
 *   - 单向基线延迟（delayMs）+ 随机抖动（jitterMs）
 *   - 令牌桶带宽整形（rateKbps，按 chunkBytes 分片发送）
 *   - 随机丢包（lossPct）：按分片概率命中「一次传输机会丢失」，随后**重传**（多等一个
 *     RTO）。这是关键：TCP 丢包不会让字节流缺字节，只会让它变慢。如果在这里真的丢字节，
 *     模拟出来的是「协议损坏」而不是「弱网」，WebSocket 会永久卡在半帧上——
 *     那是错误的实验装置，不是被测对象的问题。
 *   - 静默黑洞（blackholeFor(ms)）：两种语义
 *       `stall`（默认）：字节被暂存，黑洞结束后补齐 —— 连接活着，但应用层会看到一段
 *               长达数百毫秒到数秒的静默期，这正是心跳误杀 WebSocket 的场景。
 *       `drop`（模拟 NAT 超时 / 基站切换）：黑洞结束后物理断开连接 —— 静默期不会
 *               自己恢复，只能靠客户端重连。
 *   - 强制闪断（dropConnections({ rst })）：立即 RST，用于测「重连 + 差量续传」。
 *   - 精确双向字节与连接计数（stats() / resetStats()）：用于断言增量流量与压缩比。
 */

import { createServer, connect } from 'node:net';

/**
 * 启动一个弱网 TCP 代理。
 * @param {object} opts
 * @param {string} [opts.targetHost='127.0.0.1']
 * @param {number} opts.targetPort
 * @param {number} [opts.delayMs=0] 单向延迟毫秒
 * @param {number} [opts.jitterMs=0] 随机正负抖动毫秒
 * @param {number} [opts.rateKbps=0] 带宽上限（kbps，0 表示不限速）
 * @param {number} [opts.lossPct=0] 随机丢包百分比（0–100，命中后重传）
 * @param {number} [opts.retransmitMs=300] 丢包重传额外等待（近似一次 TCP RTO）
 * @param {number} [opts.chunkBytes=1024] 限速分片大小
 * @returns {Promise<object>} 代理句柄（见文件末尾的 resolve 形状）
 */
export function createNetemProxy({
  targetHost = '127.0.0.1',
  targetPort,
  delayMs = 0,
  jitterMs = 0,
  rateKbps = 0,
  lossPct = 0,
  retransmitMs = 300,
  chunkBytes = 1024,
} = {}) {
  if (!Number.isInteger(targetPort) || targetPort <= 0) {
    throw new Error('createNetemProxy requires a valid targetPort');
  }

  const profile = { delayMs, jitterMs, rateKbps, lossPct, retransmitMs };
  /** 黑洞状态：'off' | 'stall' | 'drop' */
  let blackhole = 'off';
  let upBytes = 0;
  let downBytes = 0;
  let connections = 0;
  let retransmits = 0;

  /** @type {Set<object>} */
  const pairs = new Set();

  function computeDelay() {
    const base = Math.max(0, Number(profile.delayMs) || 0);
    const jit = Math.max(0, Number(profile.jitterMs) || 0);
    if (jit === 0) return base;
    return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * jit));
  }

  /**
   * 为单向流创建保序的「延迟 + 限速 + 丢包 + 黑洞暂存」管道。
   * TCP 字节流必须严格保序：即使有 jitter，后到的分片也不能超越先到的分片，
   * 所以这里维护 `availableAfter`（链路空闲时刻）而不是各自独立定时。
   */
  function createPipe(src, dst, onBytes, timers, state) {
    let availableAfter = Date.now();
    let closed = false;

    /** 黑洞期间被暂存的字节（stall 语义：TCP 会在恢复后补齐）。 */
    const stalled = [];

    function writeNow(buf) {
      if (closed || dst.destroyed) return;
      onBytes(buf.length);
      dst.write(buf);
    }

    function scheduleChunk(buf, { ignoreBlackhole = false } = {}) {
      if (closed) return;
      if (!ignoreBlackhole && blackhole !== 'off') { stalled.push(buf); return; }

      // 随机丢包 = 「这一次传输机会丢了」→ TCP 重传，所以字节仍然要送到，
      // 只是多等一个 RTO。字节流完整性必须保持，否则测的就不是弱网了。
      const loss = Math.max(0, Math.min(100, Number(profile.lossPct) || 0));
      let penalty = 0;
      if (loss > 0 && Math.random() * 100 < loss) {
        retransmits += 1;
        penalty = Math.max(0, Number(profile.retransmitMs) || 0);
      }

      const now = Date.now();
      const netDelay = computeDelay() + penalty;
      const rate = Number(profile.rateKbps) || 0;
      // rateKbps -> bytes per ms = (rate * 1000 / 8) / 1000 = rate * 0.125
      const serialMs = rate > 0 ? Math.ceil(buf.length / (rate * 0.125)) : 0;
      const startAt = Math.max(now + netDelay, availableAfter);
      const fireAt = startAt + serialMs;
      availableAfter = fireAt;
      const wait = Math.max(0, fireAt - now);

      if (wait === 0) { writeNow(buf); return; }
      const t = setTimeout(() => {
        timers.delete(t);
        writeNow(buf);
      }, wait);
      timers.add(t);
    }

    src.on('data', (chunk) => {
      if (closed) return;
      const maxSlice = Number(profile.rateKbps) > 0 ? Math.max(256, chunkBytes) : chunk.length;
      for (let off = 0; off < chunk.length; off += maxSlice) {
        scheduleChunk(chunk.subarray(off, Math.min(chunk.length, off + maxSlice)));
      }
    });

    src.on('end', () => {
      const wait = Math.max(0, availableAfter - Date.now() + computeDelay());
      const t = setTimeout(() => {
        timers.delete(t);
        if (!closed && !dst.destroyed) { try { dst.end(); } catch { /* ignore */ } }
      }, wait);
      timers.add(t);
    });

    state.flushStalled = () => {
      availableAfter = Date.now();
      for (const buf of stalled.splice(0, stalled.length)) scheduleChunk(buf, { ignoreBlackhole: true });
    };

    return () => { closed = true; stalled.length = 0; };
  }

  const server = createServer((client) => {
    connections += 1;
    client.setNoDelay(true);
    const timers = new Set();
    const upstream = connect({ host: targetHost, port: targetPort });
    upstream.setNoDelay(true);
    const state = { flushStalled: () => {} };
    const pair = { client, upstream, timers, state };
    pairs.add(pair);

    const stopUp = createPipe(client, upstream, (n) => { upBytes += n; }, timers, state);
    const stopDown = createPipe(upstream, client, (n) => { downBytes += n; }, timers, state);

    function cleanup() {
      stopUp();
      stopDown();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      pairs.delete(pair);
      try { client.destroy(); } catch { /* ignore */ }
      try { upstream.destroy(); } catch { /* ignore */ }
    }

    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        host: '127.0.0.1',
        port: addr.port,
        setProfile(patch = {}) {
          for (const key of ['delayMs', 'jitterMs', 'rateKbps', 'lossPct', 'retransmitMs']) {
            if (patch[key] !== undefined) profile[key] = patch[key];
          }
        },
        /**
         * 开关黑洞。
         * @param {boolean|'off'|'stall'|'drop'} active
         */
        setBlackhole(active) {
          const next = active === true ? 'stall' : active === false ? 'off' : String(active);
          blackhole = next === 'off' ? 'off' : next === 'drop' ? 'drop' : 'stall';
          if (blackhole === 'off') {
            for (const p of pairs) p.state.flushStalled();
          }
        },
        /**
         * 黑洞 ms 毫秒。
         * @param {number} ms
         * @param {'stall'|'drop'} [mode='stall'] stall=恢复后补齐（连接活着）；
         *   drop=恢复即断连（NAT 超时/基站切换，只能重连）
         */
        async blackholeFor(ms, mode = 'stall') {
          this.setBlackhole(mode);
          await new Promise((r) => setTimeout(r, ms));
          this.setBlackhole('off');
          if (mode === 'drop') this.dropConnections({ rst: true });
        },
        dropConnections({ rst = true } = {}) {
          const count = pairs.size;
          for (const p of [...pairs]) {
            for (const t of p.timers) clearTimeout(t);
            p.timers.clear();
            try {
              if (rst && typeof p.client.resetAndDestroy === 'function') p.client.resetAndDestroy();
              else p.client.destroy();
            } catch { /* ignore */ }
            try {
              if (rst && typeof p.upstream.resetAndDestroy === 'function') p.upstream.resetAndDestroy();
              else p.upstream.destroy();
            } catch { /* ignore */ }
            pairs.delete(p);
          }
          return count;
        },
        stats() {
          return {
            upBytes,
            downBytes,
            totalBytes: upBytes + downBytes,
            connections,
            activeConnections: pairs.size,
            retransmits,
            blackhole,
          };
        },
        resetStats() {
          upBytes = 0;
          downBytes = 0;
          connections = 0;
          retransmits = 0;
        },
        async close() {
          blackhole = 'off';
          for (const p of [...pairs]) {
            for (const t of p.timers) clearTimeout(t);
            p.timers.clear();
            try { p.client.destroy(); } catch { /* ignore */ }
            try { p.upstream.destroy(); } catch { /* ignore */ }
          }
          pairs.clear();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}
