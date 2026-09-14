"""简易基频(F0)估计：WAV/PCM16 单声道化后自相关法。用法: python f0.py a.wav [b.wav ...]"""
import sys, wave, array

def load_mono(path):
    w = wave.open(path, 'rb')
    n, sw, ch, fr = w.getnframes(), w.getsampwidth(), w.getnchannels(), w.getframerate()
    raw = w.readframes(n); w.close()
    a = array.array('h'); a.frombytes(raw[:len(raw)//2*2])
    if ch == 2: a = array.array('h', a[0::2])
    return a, fr

def f0(path):
    a, fr = load_mono(path)
    # 降采样到 8kHz 提速
    dec = max(1, fr // 8000)
    if dec > 1:
        a = array.array('h', a[::dec]); fr //= dec
    # 找能量最高的 1 秒段（大概率是稳定人声）
    win = fr
    if len(a) < win: return None
    best, bi = -1, 0
    for i in range(0, len(a) - win, win // 2):
        e = sum(x * x for x in a[i:i+win:8])
        if e > best: best, bi = e, i
    seg = a[bi:bi+win]
    # RMS 门槛
    rms = (sum(x * x for x in seg) / len(seg)) ** 0.5
    if rms < 100: return None
    # 去直流
    m = sum(seg) / len(seg)
    seg = [x - m for x in seg]
    # 自相关，搜索 60-400Hz
    lo, hi = fr // 400, fr // 60
    best_l, best_r = 0, 0.0
    for lag in range(lo, min(hi, len(seg) // 2)):
        s = 0.0
        for j in range(0, len(seg) - lag, 4):
            s += seg[j] * seg[j + lag]
        s /= (len(seg) - lag) / 4
        if s > best_r: best_r, best_l = s, lag
    if not best_l: return None
    # 归一化置信度
    e0 = sum(x * x for x in seg) / len(seg)
    conf = best_r / e0 if e0 else 0
    return fr / best_l, conf

for p in sys.argv[1:]:
    try:
        r = f0(p)
        print(f"{p}: F0={r[0]:.0f}Hz conf={r[1]:.2f}" if r else f"{p}: 无有效人声")
    except Exception as e:
        print(f"{p}: 错误 {e}")
