import { c as _c } from "react-compiler-runtime";
import React, { createContext, useContext, useEffect } from 'react';
import { saveCurrentProjectConfig } from '../utils/config.js';
export type StatsStore = {
  increment(name: string, value?: number): void;
  set(name: string, value: number): void;
  observe(name: string, value: number): void;
  add(name: string, value: string): void;
  getAll(): Record<string, number>;
};
function percentile(sorted: number[], p: number): number {
  const index = p / 100 * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower]!;
  }
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}
const RESERVOIR_SIZE = 1024;
type Histogram = {
  reservoir: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
};
export function createStatsStore(): StatsStore {
  const metrics = new Map<string, number>();
  const histograms = new Map<string, Histogram>();
  const sets = new Map<string, Set<string>>();
  return {
    increment(name: string, value = 1) {
      metrics.set(name, (metrics.get(name) ?? 0) + value);
    },
    set(name: string, value: number) {
      metrics.set(name, value);
    },
    observe(name: string, value: number) {
      let h = histograms.get(name);
      if (!h) {
        h = {
          reservoir: [],
          count: 0,
          sum: 0,
          min: value,
          max: value
        };
        histograms.set(name, h);
      }
      h.count++;
      h.sum += value;
      if (value < h.min) {
        h.min = value;
      }
      if (value > h.max) {
        h.max = value;
      }
      // Reservoir sampling (Algorithm R)
      if (h.reservoir.length < RESERVOIR_SIZE) {
        h.reservoir.push(value);
      } else {
        const j = Math.floor(Math.random() * h.count);
        if (j < RESERVOIR_SIZE) {
          h.reservoir[j] = value;
        }
      }
    },
    add(name: string, value: string) {
      let s = sets.get(name);
      if (!s) {
        s = new Set();
        sets.set(name, s);
      }
      s.add(value);
    },
    getAll() {
      const result: Record<string, number> = Object.fromEntries(metrics);
      for (const [name, h] of histograms) {
        if (h.count === 0) {
          continue;
        }
        result[`${name}_count`] = h.count;
        result[`${name}_min`] = h.min;
        result[`${name}_max`] = h.max;
        result[`${name}_avg`] = h.sum / h.count;
        const sorted = [...h.reservoir].sort((a, b) => a - b);
        result[`${name}_p50`] = percentile(sorted, 50);
        result[`${name}_p95`] = percentile(sorted, 95);
        result[`${name}_p99`] = percentile(sorted, 99);
      }
      for (const [name, s] of sets) {
        result[name] = s.size;
      }
      return result;
    }
  };
}
export const StatsContext = createContext<StatsStore | null>(null);
type Props = {
  store?: StatsStore;
  children: React.ReactNode;
};
export function StatsProvider(t0) {
  const $ = _c(7);
  const {
    store: externalStore,
    children
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = createStatsStore();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const internalStore = t1;
  const store = externalStore ?? internalStore;
  let t2;
  let t3;
  if ($[1] !== store) {
    t2 = () => {
      const flush = () => {
        const metrics = store.getAll();
        if (Object.keys(metrics).length > 0) {
          saveCurrentProjectConfig(current => ({
            ...current,
            lastSessionMetrics: metrics
          }));
        }
      };
      process.on("exit", flush);
      return () => {
        process.off("exit", flush);
      };
    };
    t3 = [store];
    $[1] = store;
    $[2] = t2;
    $[3] = t3;
  } else {
    t2 = $[2];
    t3 = $[3];
  }
  useEffect(t2, t3);
  let t4;
  if ($[4] !== children || $[5] !== store) {
    t4 = <StatsContext.Provider value={store}>{children}</StatsContext.Provider>;
    $[4] = children;
    $[5] = store;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  return t4;
}
export function useStats() {
  const store = useContext(StatsContext);
  if (!store) {
    throw new Error("useStats must be used within a StatsProvider");
  }
  return store;
}
export function useCounter(name) {
  const $ = _c(3);
  const store = useStats();
  let t0;
  if ($[0] !== name || $[1] !== store) {
    t0 = value => store.increment(name, value);
    $[0] = name;
    $[1] = store;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}
export function useGauge(name) {
  const $ = _c(3);
  const store = useStats();
  let t0;
  if ($[0] !== name || $[1] !== store) {
    t0 = value => store.set(name, value);
    $[0] = name;
    $[1] = store;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}
export function useTimer(name) {
  const $ = _c(3);
  const store = useStats();
  let t0;
  if ($[0] !== name || $[1] !== store) {
    t0 = value => store.observe(name, value);
    $[0] = name;
    $[1] = store;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}
export function useSet(name) {
  const $ = _c(3);
  const store = useStats();
  let t0;
  if ($[0] !== name || $[1] !== store) {
    t0 = value => store.add(name, value);
    $[0] = name;
    $[1] = store;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}
