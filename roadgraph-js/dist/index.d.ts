// Copyright (c) 2026 NumFast
// SPDX-License-Identifier: AGPL-3.0-only
export type Profile = "car" | "foot";
export interface RoadMap {
    N: number;
    M: number;
    nodeLon: Int32Array;
    nodeLat: Int32Array;
    off: Int32Array;
    heads: Int32Array;
    length: Uint32Array;
    speed: Uint32Array;
    grid: Map<string, number[]>;
}
export interface SnapRes {
    node: number;
    mm: number;
    ring: number;
}
export interface RouteResult {
    reachable: boolean;
    duration_ms: number | null;
    distance_m: number | null;
    snap_node: [number, number];
    snap_mm: [number, number];
    rings: [number, number];
    settled: number;
    path: number[];
    polyline: [number, number][];
}
export declare function loadMap(parts: {
    nodeLon: ArrayBuffer;
    nodeLat: ArrayBuffer;
    offsets: ArrayBuffer;
    heads: ArrayBuffer;
    length: ArrayBuffer;
    speed: ArrayBuffer;
}): RoadMap;
export declare function loadMapFromFetch(base: string): Promise<RoadMap>;
export declare function snap(map: RoadMap, lon: number, lat: number): SnapRes;
export declare function route(map: RoadMap, a: [number, number], b: [number, number], profile: Profile): RouteResult;
export declare function batch(map: RoadMap, pairs: [number, number, number, number][], profile: Profile, chunk?: number, onProgress?: (done: number, total: number) => void): Promise<RouteResult[]>;
