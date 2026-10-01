"""Regenerate test/fixtures/dsp_reference.json (scipy reference for dsp.js).

Run from the repository root:

    python3 test/fixtures/make_dsp_reference.py

Needs numpy and scipy. The tests only read the JSON, so CI does not need
Python. The input signal is synthetic (sum of sines plus a fixed LCG noise
sequence) and is stored in the JSON next to the reference outputs.
"""
import json
import math
import os

import numpy as np
import scipy
import scipy.signal as sig

FS = 30.0
N = 450  # 15 s at 30 Hz


def lcg_noise(n, seed=12345):
    """Deterministic uniform noise in [-0.5, 0.5) from a 32-bit LCG."""
    out = []
    state = seed
    for _ in range(n):
        state = (1664525 * state + 1013904223) % (2 ** 32)
        out.append(state / 2 ** 32 - 0.5)
    return out


def main():
    noise = lcg_noise(N)
    x = [
        math.sin(2 * math.pi * 1.2 * i / FS)
        + 0.5 * math.sin(2 * math.pi * 2.4 * i / FS + 0.3)
        + 0.8 * math.sin(2 * math.pi * 0.2 * i / FS)
        + 0.3 * math.sin(2 * math.pi * 6.0 * i / FS)
        + 0.4 * noise[i]
        for i in range(N)
    ]
    b, a = sig.butter(4, [0.7 / (FS / 2), 4.0 / (FS / 2)], "band")
    xa = np.asarray(x, dtype=np.float64)
    fwd = sig.lfilter(b, a, xa)
    # dsp.js filtfilt is a plain forward pass, reverse, forward pass, reverse
    # with zero initial state and no padding; scipy.signal.filtfilt pads and
    # sets initial conditions, so build the same composition explicitly.
    fwd_rev = sig.lfilter(b, a, fwd[::-1])[::-1]
    ref = {
        "command": "python3 test/fixtures/make_dsp_reference.py",
        "scipy_version": scipy.__version__,
        "fs": FS,
        "butter_call": "scipy.signal.butter(4, [0.7/15, 4.0/15], 'band')",
        "b": [float(v) for v in b],
        "a": [float(v) for v in a],
        "x": [float(v) for v in xa],
        "lfilter": [float(v) for v in fwd],
        "forward_reverse": [float(v) for v in fwd_rev],
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dsp_reference.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(ref, fh, indent=1)
        fh.write("\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
