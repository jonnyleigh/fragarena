/**
 * procedural.js — deterministic procedural mesh generation
 *
 *  generateShipGeometry(seed)     → THREE.BufferGeometry
 *  generateShieldMesh(shieldData) → THREE.Group
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';

// ------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ------------------------------------------------------------------

function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s  += 0x6D2B79F5;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------
// Ship geometry — delta/wedge shape, mirrored on X axis
// ------------------------------------------------------------------

export function generateShipGeometry(seed) {
    const rng = makeRng(seed);

    // Define a half-ship in local (positive-X) space as a set of vertices,
    // then mirror to negative X for symmetry.
    // Base shape: pointed nose at front (-Z), engines at back (+Z).

    const jitter = () => (rng() - 0.5) * 2;

    // Core points (positive X side, will be mirrored)
    const nose  = [0,   0,          -20];
    const wing1 = [8  + jitter() * 4,  -1 + jitter(), -5  + jitter() * 6];
    const wing2 = [18 + jitter() * 4,   0,              5  + jitter() * 6];
    const wing3 = [10 + jitter() * 3,  1 + jitter(),   14 + jitter() * 4];
    const eng1  = [4  + jitter() * 2,  -1 + jitter(),  18 + jitter() * 2];
    const eng2  = [2  + jitter(),       2 + jitter(),  18 + jitter() * 2];
    const top   = [0, 5 + jitter() * 3, 2 + jitter() * 4];

    // Mirror each right-side point to left side
    const m = (p) => [-p[0], p[1], p[2]];

    // Vertices array (right side then left side)
    const verts = [
        nose,                   // 0
        wing1, wing2, wing3,    // 1,2,3 right
        eng1, eng2,             // 4,5 right
        top,                    // 6
        m(wing1), m(wing2), m(wing3), // 7,8,9 left
        m(eng1),  m(eng2),      // 10,11 left
    ];

    // Triangles (counter-clockwise from outside)
    const tris = [
        // Nose to right wing
        [0, 1, 2], [0, 2, 3],
        // Right body
        [0, 3, 6], [3, 4, 5], [3, 5, 6], [4, 6, 5],
        // Right engine back
        [3, 4, 9], [4, 10, 9],
        // Nose to left wing
        [0, 8, 7], [0, 9, 8],
        // Left body
        [0, 6, 9], [9, 11, 10], [9, 6, 11], [10, 6, 11],
        // Left engine back
        [9, 15, 10],  // wrap
        // Centre belly
        [0, 7, 1], [4, 10, 5], [5, 10, 11],
        // Top spine
        [6, 2, 1], [6, 3, 2], [6, 8, 9], [6, 7, 8],
    ].filter(t => t.every(i => i < verts.length));

    const positions = [];
    for (const [a, b, c] of tris) {
        positions.push(...verts[a], ...verts[b], ...verts[c]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
}

// ------------------------------------------------------------------
// Shield mesh — stacked stone blocks forming a small wall cluster
// ------------------------------------------------------------------

export function generateShieldMesh(shieldData, stoneTex) {
    const { x, y, z, w, h, d } = shieldData;
    const group = new THREE.Group();

    const mat = new THREE.MeshLambertMaterial({
        map:  stoneTex ?? null,
        color: stoneTex ? 0xffffff : 0x888888,
    });

    // Subdivide the shield box into 1–3 stacked sub-blocks for visual variety
    const blockCount = Math.max(1, Math.round(h / 35));
    const blockH     = h / blockCount;
    for (let i = 0; i < blockCount; i++) {
        const slop = (Math.random() - 0.5) * 4;  // slight random offset
        const geo  = new THREE.BoxGeometry(w + slop, blockH - 2, d + slop);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x + slop / 2, y - h / 2 + blockH * i + blockH / 2, z + slop / 2);
        group.add(mesh);
    }

    return group;
}
