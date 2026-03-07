/**
 * radar.js — 3D sphere-projection radar display
 *
 * Renders to a small 2D canvas overlay.
 * Projects the relative azimuth + elevation of each other player
 * as a blip on a circle (top-down blip = ahead/behind).
 *
 * Blip colours:
 *   cyan  = human player
 *   red   = bot
 *   white = self (centre dot)
 */

export class Radar {
    constructor(canvasEl) {
        this.canvas  = canvasEl;
        this.ctx     = canvasEl.getContext('2d');
        this.radius  = canvasEl.width  / 2;
        this.cx      = this.radius;
        this.cy      = this.radius;
        this.maxRange = 350;   // units — beyond this blips are at the rim
    }

    /**
     * Draw the radar for this frame.
     *
     * @param {THREE.Vector3} localPos      - local player world position
     * @param {THREE.Quaternion} localRot   - local player world rotation
     * @param {Array} players               - server state players array
     * @param {string} localPlayerId
     */
    draw(localPos, localRot, players, localPlayerId) {
        const { ctx, cx, cy, radius } = this;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Background circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius - 2, 0, Math.PI * 2);
        ctx.fillStyle   = 'rgba(0,20,40,0.75)';
        ctx.fill();
        ctx.strokeStyle = '#0af';
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.restore();

        // Compass rings
        for (const r of [0.33, 0.66, 1.0]) {
            ctx.beginPath();
            ctx.arc(cx, cy, (radius - 2) * r, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,170,255,0.2)';
            ctx.lineWidth   = 0.5;
            ctx.stroke();
        }

        // Centre dot (self)
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Build inverse rotation matrix to transform world positions into player-local space
        const invRot = localRot.clone().invert();

        for (const p of players) {
            if (p.id === localPlayerId || p.isDead) continue;

            // World-space offset from local player
            const wx = p.position.x - localPos.x;
            const wy = p.position.y - localPos.y;
            const wz = p.position.z - localPos.z;

            // Rotate into local camera space
            const local = _rotateVec3(wx, wy, wz, invRot);

            // Elevation-weighted projection onto radar circle
            const hDist = Math.sqrt(local.x * local.x + local.z * local.z);
            const totalDist = Math.sqrt(wx*wx + wy*wy + wz*wz);

            const fraction = Math.min(1, totalDist / this.maxRange);
            const angle    = Math.atan2(local.x, -local.z);   // azimuth (forward = up on radar)

            const bx = cx + Math.sin(angle) * fraction * (radius - 6);
            const by = cy - Math.cos(angle) * fraction * (radius - 6);

            // Blip size by elevation: above = larger, below = smaller
            const elev    = Math.atan2(local.y, Math.max(1, hDist));
            const blipR   = 3 + elev * 2;

            ctx.beginPath();
            ctx.arc(bx, by, Math.max(2, blipR), 0, Math.PI * 2);
            ctx.fillStyle  = p.isBot ? '#ff4444' : '#00cfff';
            ctx.fill();

            // Elevation tick mark
            const tickLen = Math.abs(elev) * 8;
            if (tickLen > 1) {
                const sign = local.y > 0 ? -1 : 1;
                ctx.beginPath();
                ctx.moveTo(bx, by);
                ctx.lineTo(bx, by + sign * tickLen);
                ctx.strokeStyle = p.isBot ? '#ff4444' : '#00cfff';
                ctx.lineWidth   = 1;
                ctx.stroke();
            }
        }
    }
}

// ------------------------------------------------------------------
// Utility — rotate a vec3 by a quaternion without importing Three.js
// ------------------------------------------------------------------

function _rotateVec3(x, y, z, q) {
    const { x: qx, y: qy, z: qz, w: qw } = q;
    // v' = q * v * q^-1  — via double cross product trick
    const ix =  qw*x + qy*z - qz*y;
    const iy =  qw*y + qz*x - qx*z;
    const iz =  qw*z + qx*y - qy*x;
    const iw = -qx*x - qy*y - qz*z;
    return {
        x: ix*qw + iw*(-qx) + iy*(-qz) - iz*(-qy),
        y: iy*qw + iw*(-qy) + iz*(-qx) - ix*(-qz),
        z: iz*qw + iw*(-qz) + ix*(-qy) - iy*(-qx),
    };
}
