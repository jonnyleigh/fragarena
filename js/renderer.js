/**
 * renderer.js — Three.js WebGL renderer + scene management
 *
 * Manages:
 *   - WebGLRenderer, PerspectiveCamera
 *   - Scene lighting
 *   - Local player ship mesh (attached to camera)
 *   - Explosion particles on death events
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
import { generateShipGeometry } from './procedural.js';

export class Renderer {
    constructor(canvas, playerSeed) {
        this.canvas = canvas;

        // ------ Renderer ------
        this._renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: false,   // performance over quality
            powerPreference: 'high-performance',
        });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this._renderer.setSize(window.innerWidth, window.innerHeight);

        // ------ Scene ------
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x000011, 300, 600);
        this.scene.background = new THREE.Color(0x000011);

        // ------ Camera ------
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.5,
            800,
        );

        // ------ Lighting ------
        const ambient = new THREE.AmbientLight(0x222244, 2);
        const sun     = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(100, 200, 100);
        this.scene.add(ambient, sun);

        // ------ Local ship mesh (visible to self — just cockpit frame) ------
        //  We don't show our own hull; instead we add a small cockpit pip
        this._cockpit = this._makeCockpit();
        this.camera.add(this._cockpit);
        this.scene.add(this.camera);

        // Death flash overlay (red quad in front of camera)
        this._deathFlash   = 0;       // opacity 0..1
        this._flashMesh    = this._makeFlashMesh();
        this.camera.add(this._flashMesh);

        // Explosion particles pool
        this._explosions = [];

        window.addEventListener('resize', this._onResize.bind(this));
    }

    // ------------------------------------------------------------------
    // Camera sync
    // ------------------------------------------------------------------

    /** Sync camera to local player transform each frame. */
    syncCamera(position, quaternion) {
        this.camera.position.copy(position);
        this.camera.quaternion.copy(quaternion);
    }

    // ------------------------------------------------------------------
    // Death flash
    // ------------------------------------------------------------------

    triggerDeathFlash() { this._deathFlash = 1.0; }

    _updateDeathFlash(dt) {
        if (this._deathFlash > 0) {
            this._deathFlash = Math.max(0, this._deathFlash - dt * 2);
            this._flashMesh.material.opacity = this._deathFlash * 0.7;
            this._flashMesh.visible = this._deathFlash > 0;
        }
    }

    // ------------------------------------------------------------------
    // Explosions
    // ------------------------------------------------------------------

    spawnExplosion(position) {
        const count  = 60;
        const verts  = [];
        const velocities = [];
        for (let i = 0; i < count; i++) {
            verts.push(0, 0, 0);
            const theta = Math.random() * Math.PI * 2;
            const phi   = Math.random() * Math.PI;
            const spd   = 30 + Math.random() * 80;
            velocities.push(
                Math.sin(phi) * Math.cos(theta) * spd,
                Math.sin(phi) * Math.sin(theta) * spd,
                Math.cos(phi) * spd,
            );
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        const mat  = new THREE.PointsMaterial({ color: 0xff6600, size: 4, sizeAttenuation: true });
        const pts  = new THREE.Points(geo, mat);
        pts.position.copy(position);
        this.scene.add(pts);

        this._explosions.push({ pts, velocities, ttl: 1.0, elapsed: 0 });
    }

    _updateExplosions(dt) {
        this._explosions = this._explosions.filter(ex => {
            ex.elapsed += dt;
            if (ex.elapsed >= ex.ttl) {
                this.scene.remove(ex.pts);
                ex.pts.geometry.dispose();
                ex.pts.material.dispose();
                return false;
            }
            const positions = ex.pts.geometry.attributes.position.array;
            for (let i = 0; i < ex.velocities.length / 3; i++) {
                positions[i*3]   += ex.velocities[i*3]   * dt;
                positions[i*3+1] += ex.velocities[i*3+1] * dt;
                positions[i*3+2] += ex.velocities[i*3+2] * dt;
            }
            ex.pts.geometry.attributes.position.needsUpdate = true;
            ex.pts.material.opacity = 1 - ex.elapsed / ex.ttl;
            ex.pts.material.transparent = true;
            return true;
        });
    }

    // ------------------------------------------------------------------
    // Main render
    // ------------------------------------------------------------------

    render(dt) {
        this._updateDeathFlash(dt);
        this._updateExplosions(dt);
        this._renderer.render(this.scene, this.camera);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _makeCockpit() {
        // Simple aim crosshair geometry visible in cockpit view
        const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-0.3, 0, -2),
            new THREE.Vector3( 0.3, 0, -2),
            new THREE.Vector3(0, -0.3, -2),
            new THREE.Vector3(0,  0.3, -2),
        ]);
        const mat  = new THREE.LineBasicMaterial({ color: 0x00ff88, opacity: 0.6, transparent: true });
        const mesh = new THREE.LineSegments(geo, mat);
        return mesh;
    }

    _makeFlashMesh() {
        const geo  = new THREE.PlaneGeometry(4, 4);
        const mat  = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            transparent: true,
            opacity: 0,
            depthTest: false,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(0, 0, -1.5);
        mesh.visible = false;
        return mesh;
    }

    _onResize() {
        this._renderer.setSize(window.innerWidth, window.innerHeight);
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
    }
}
