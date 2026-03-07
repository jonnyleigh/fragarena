// c:\Users\jonny\Source\repos\FragArena\js\sound-manager.js

function applyEnvelope(gainNode, ctx, { attack, decay, sustain, release }, startTime, duration) {
  const g = gainNode.gain;
  g.setValueAtTime(0, startTime);
  g.linearRampToValueAtTime(1, startTime + attack);
  g.linearRampToValueAtTime(sustain, startTime + attack + decay);
  g.setValueAtTime(sustain, startTime + duration - release);
  g.linearRampToValueAtTime(0, startTime + duration);
}

class SoundManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    
    // Load from localStorage or use defaults
    this.sfxEnabled = localStorage.getItem('spaceGame_sfxEnabled') !== 'false';
    this.musicEnabled = localStorage.getItem('spaceGame_musicEnabled') !== 'false';
    this.sfxVolume = parseInt(localStorage.getItem('spaceGame_sfxVolume') || '80', 10) / 100;
    this.musicVolume = parseInt(localStorage.getItem('spaceGame_musicVolume') || '50', 10) / 100;
    
    this.buffers = {};
    this.musicTracks = [];
    this.currentTrack = null;
    this.currentTrackIndex = -1;
    this.crossfadeTime = 2;
    
    this.activeNodesCount = 0;
    this.maxActiveNodes = 24;
    this._listenerPosition = { x: 0, y: 0, z: 0 };

    // Node pools for high frequency sounds
    this.pools = {
      pulse_laser_fire: [],
      railgun_fire: [],
      impact_hull: []
    };
    this.poolSize = 8;
    
    // Throttle timestamps
    this.lastPlayed = {};
    
    // Priorities
    this.priorities = {
      explosion_ship: 70,
      player_hurt: 60,
      sonic_boom: 60,
      impact_hull: 50,
      impact_shield: 50,
      pulse_laser_fire: 40,
      railgun_fire: 40,
      beam_laser_hum: 40,
      missile_launch: 30,
      ambience_space: 20
    };

    // Lazy initialization binding
    this._onFirstGesture = this._onFirstGesture.bind(this);
    window.addEventListener('click', this._onFirstGesture, { once: true });
    window.addEventListener('keydown', this._onFirstGesture, { once: true });
  }

  async _onFirstGesture() {
    if (this.ctx) return;
    
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxEnabled ? this.sfxVolume : 0;
    
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicEnabled ? this.musicVolume : 0;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(compressor);
    compressor.connect(this.ctx.destination);

    this._generateBuffers();
    this._initPools();
    
    await this.discoverMusicTracks();
  }

  _createWhiteNoise(duration) {
    const bufferSize = this.ctx.sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  _generateBuffers() {
    this.buffers.whiteNoise1s = this._createWhiteNoise(1.0);
    this.buffers.whiteNoise015s = this._createWhiteNoise(0.15);
    this.buffers.whiteNoise03s = this._createWhiteNoise(0.3);
    this.buffers.whiteNoise02s = this._createWhiteNoise(0.2);
    this.buffers.whiteNoise15s = this._createWhiteNoise(1.5);
    this.buffers.whiteNoise06s = this._createWhiteNoise(0.6);
    this.buffers.whiteNoise002s = this._createWhiteNoise(0.02);
  }

  _initPools() {
    for (const type in this.pools) {
      for (let i = 0; i < this.poolSize; i++) {
        const gain = this.ctx.createGain();
        const panner = this._createPanner();
        gain.connect(panner);
        panner.connect(this.sfxGain);
        this.pools[type].push({ gain, panner, inUse: false });
      }
    }
  }

  _createPanner() {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 10;
    panner.maxDistance = 500;
    panner.rolloffFactor = 1.5;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    return panner;
  }

  _setAudioParamValue(node, propName, value) {
    const param = node?.[propName];
    if (!param) return false;
    if ('value' in param) {
      param.value = value;
      return true;
    }
    if (typeof param.setValueAtTime === 'function' && this.ctx) {
      param.setValueAtTime(value, this.ctx.currentTime);
      return true;
    }
    return false;
  }

  _setNodePosition(node, position) {
    if (!node || !position) return;

    const usedAudioParams =
      this._setAudioParamValue(node, 'positionX', position.x) &&
      this._setAudioParamValue(node, 'positionY', position.y) &&
      this._setAudioParamValue(node, 'positionZ', position.z);

    if (!usedAudioParams && typeof node.setPosition === 'function') {
      node.setPosition(position.x, position.y, position.z);
    }
  }

  _setListenerOrientation(listener, forward, up) {
    if (!listener || !forward || !up) return;

    const usedAudioParams =
      this._setAudioParamValue(listener, 'forwardX', forward.x) &&
      this._setAudioParamValue(listener, 'forwardY', forward.y) &&
      this._setAudioParamValue(listener, 'forwardZ', forward.z) &&
      this._setAudioParamValue(listener, 'upX', up.x) &&
      this._setAudioParamValue(listener, 'upY', up.y) &&
      this._setAudioParamValue(listener, 'upZ', up.z);

    if (!usedAudioParams && typeof listener.setOrientation === 'function') {
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  _getListenerPosition(listener) {
    const fallback = this._listenerPosition || { x: 0, y: 0, z: 0 };
    return {
      x: listener?.positionX?.value ?? fallback.x,
      y: listener?.positionY?.value ?? fallback.y,
      z: listener?.positionZ?.value ?? fallback.z,
    };
  }

  _getPooledNode(type) {
    if (!this.pools[type]) return null;
    const pool = this.pools[type];
    const node = pool.find(n => !n.inUse);
    if (node) {
      node.inUse = true;
      return node;
    }
    // If pool empty, just forcibly reuse the first one
    return pool[0];
  }

  play(name, worldPosition = null, options = {}) {
    if (!this.ctx || !this.sfxEnabled) return;
    if (this.activeNodesCount >= this.maxActiveNodes) {
      const priority = this.priorities[name] || 0;
      if (priority < 50) return; // Skip lower priority sounds if saturated
    }

    const distance = worldPosition ? this._getDistance(worldPosition) : 0;
    if (worldPosition && distance > 500) return; // Distance culling

    const now = this.ctx.currentTime;

    // Throttling
    if (name === 'pulse_laser_fire' && this.lastPlayed[name] && now - this.lastPlayed[name] < 0.08) return;
    if ((name === 'impact_hull' || name === 'impact_shield') && this.lastPlayed[name] && now - this.lastPlayed[name] < 0.05) return;
    this.lastPlayed[name] = now;

    let destination = this.sfxGain;
    let panner = null;
    let pooled = false;
    let poolNode = null;

    if (worldPosition) {
      if (this.pools[name]) {
        poolNode = this._getPooledNode(name);
        destination = poolNode.gain;
        panner = poolNode.panner;
        pooled = true;
      } else {
        panner = this._createPanner();
        panner.connect(this.sfxGain);
        destination = panner;
      }
      this._setNodePosition(panner, worldPosition);
    }

    const releaseNode = () => {
      this.activeNodesCount--;
      if (pooled && poolNode) poolNode.inUse = false;
    };

    this.activeNodesCount++;
    try {
      if (this[name]) {
        this[name](now, destination, options, releaseNode);
      } else {
        releaseNode();
      }
    } catch (e) {
      console.error('Sound playback error:', name, e);
      releaseNode();
    }
  }

  _getDistance(pos) {
    const l = this.ctx.listener;
    const listenerPos = this._getListenerPosition(l);
    const dx = pos.x - listenerPos.x;
    const dy = pos.y - listenerPos.y;
    const dz = pos.z - listenerPos.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  updateAudioListener(camera) {
    if (!this.ctx || !camera?.position || !camera?.up) return;

    const listener = this.ctx.listener;
    this._listenerPosition = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    };
    this._setNodePosition(listener, this._listenerPosition);

    let forward = camera.forward ?? null;
    if (!forward && typeof camera.getWorldDirection === 'function') {
      const tempDir = {
        x: 0,
        y: 0,
        z: -1,
        set(x, y, z) {
          this.x = x;
          this.y = y;
          this.z = z;
          return this;
        },
        normalize() {
          return this;
        },
      };
      camera.getWorldDirection(tempDir);
      forward = tempDir;
    }

    if (!forward) {
      forward = { x: 0, y: 0, z: -1 };
    }

    this._setListenerOrientation(listener, forward, camera.up);
  }

  // --- SOUND EFFECTS GENERATORS ---

  pulse_laser_fire(now, destination, options, onComplete) {
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(900, now);
    osc1.frequency.exponentialRampToValueAtTime(200, now + 0.12);

    const osc2 = this.ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(1800, now);
    osc2.frequency.exponentialRampToValueAtTime(400, now + 0.12);

    const gain1 = this.ctx.createGain();
    const gain2 = this.ctx.createGain();
    gain2.gain.value = 0.2;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 2;

    const masterGain = this.ctx.createGain();
    applyEnvelope(masterGain, this.ctx, { attack: 0, decay: 0.03, sustain: 0.1, release: 0.09 }, now, 0.12);

    osc1.connect(gain1);
    osc2.connect(gain2);
    gain1.connect(filter);
    gain2.connect(filter);
    filter.connect(masterGain);
    masterGain.connect(destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.12);
    osc2.stop(now + 0.12);

    setTimeout(onComplete, 120);
  }

  beam_laser_hum(now, destination, options, onComplete) {
    if (options.stop) {
      if (options.beamNode) {
        options.beamNode.gain.gain.linearRampToValueAtTime(0, now + 0.08);
        setTimeout(() => {
          options.beamNode.source.stop();
          options.beamNode.osc1.stop();
          options.beamNode.osc2.stop();
          options.beamNode.gain.disconnect();
          onComplete();
        }, 80);
      } else {
        onComplete();
      }
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers.whiteNoise1s;
    source.loop = true;

    const filter1 = this.ctx.createBiquadFilter();
    filter1.type = 'bandpass';
    filter1.frequency.value = 2400;
    filter1.Q.value = 8;
    source.connect(filter1);

    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 220;
    const osc1Gain = this.ctx.createGain();
    osc1Gain.gain.value = 0.3;
    const filter2 = this.ctx.createBiquadFilter();
    filter2.type = 'bandpass';
    filter2.frequency.value = 440;
    filter2.Q.value = 4;
    osc1.connect(osc1Gain).connect(filter2);

    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 880;
    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.15;
    osc2.connect(osc2Gain);

    const masterGain = this.ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(0.6, now + 0.05);

    filter1.connect(masterGain);
    filter2.connect(masterGain);
    osc2Gain.connect(masterGain);
    masterGain.connect(destination);

    source.start(now);
    osc1.start(now);
    osc2.start(now);

    options.beamNode = { source, osc1, osc2, gain: masterGain };
    // onComplete intentionally not called here until stopped
  }

  sonic_boom(now, destination, options, onComplete) {
    // Sharp, explosive sonic boom effect - a sudden burst of energy
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers.whiteNoise015s;

    // Aggressive initial spike using high-pass filtered white noise
    const hpFilter = this.ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.value = 4000;  // High frequencies for the snap
    hpFilter.Q.value = 3;
    source.connect(hpFilter);

    // Distortion for the shocking impact
    const ws = this.ctx.createWaveShaper();
    ws.curve = this._makeDistortionCurve(50);
    hpFilter.connect(ws);

    // Low-frequency rumble underneath
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.15);
    
    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(0.4, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    osc.connect(oscGain);

    // Master envelope - quick attack, sharp decay
    const masterGain = this.ctx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(1, now + 0.002);  // Nearly instant attack
    masterGain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);  // Quick decay

    ws.connect(masterGain);
    oscGain.connect(masterGain);
    masterGain.connect(destination);

    source.start(now);
    osc.start(now);
    source.stop(now + 0.15);
    osc.stop(now + 0.15);

    setTimeout(onComplete, 150);
  }

  railgun_fire(now, destination, options, onComplete) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers.whiteNoise015s;

    const attackGain = this.ctx.createGain();
    attackGain.gain.setValueAtTime(0, now);
    attackGain.gain.linearRampToValueAtTime(1, now + 0.001);
    attackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    source.connect(attackGain);

    const hpFilter = this.ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.value = 3000;

    const pkFilter = this.ctx.createBiquadFilter();
    pkFilter.type = 'peaking';
    pkFilter.frequency.value = 6000;
    pkFilter.gain.value = 12;
    pkFilter.Q.value = 1;

    attackGain.connect(hpFilter);
    hpFilter.connect(pkFilter);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.08);
    
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0.4;
    osc.connect(oscGain);

    const ws = this.ctx.createWaveShaper();
    ws.curve = this._makeDistortionCurve(40);
    
    pkFilter.connect(ws);
    oscGain.connect(ws);
    ws.connect(destination);

    source.start(now);
    osc.start(now);
    source.stop(now + 0.15);
    osc.stop(now + 0.08);

    setTimeout(onComplete, 150);
  }

  missile_launch(now, destination, options, onComplete) {
    // Ignition thump
    const ignSource = this.ctx.createBufferSource();
    ignSource.buffer = this.buffers.whiteNoise015s;
    const ignFilter = this.ctx.createBiquadFilter();
    ignFilter.type = 'lowpass';
    ignFilter.frequency.value = 200;
    const ignGain = this.ctx.createGain();
    ignGain.gain.setValueAtTime(0, now);
    ignGain.gain.linearRampToValueAtTime(1, now + 0.002);
    ignGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    ignSource.connect(ignFilter).connect(ignGain).connect(destination);
    ignSource.start(now);

    // Thrust roar (approximate pink noise)
    const thrustSource = this.ctx.createBufferSource();
    thrustSource.buffer = this.buffers.whiteNoise1s;
    thrustSource.loop = true;
    
    const f800 = this.ctx.createBiquadFilter(); f800.type = 'lowpass'; f800.frequency.value = 800;
    const f400 = this.ctx.createBiquadFilter(); f400.type = 'lowpass'; f400.frequency.value = 400;
    const f200 = this.ctx.createBiquadFilter(); f200.type = 'lowpass'; f200.frequency.value = 200;
    
    thrustSource.connect(f800);
    thrustSource.connect(f400);
    thrustSource.connect(f200);

    const thrustGain = this.ctx.createGain();
    thrustGain.gain.setValueAtTime(0, now);
    thrustGain.gain.linearRampToValueAtTime(0.5, now + 0.3);
    
    f800.connect(thrustGain);
    f400.connect(thrustGain);
    f200.connect(thrustGain);
    thrustGain.connect(destination);
    
    thrustSource.start(now);
    thrustSource.stop(now + 4);

    if (options.missileNodeTracker) {
      options.missileNodeTracker.thrustSource = thrustSource;
    }

    setTimeout(onComplete, 4000);
  }

  explosion_ship(now, destination, options, onComplete) {
    const source1 = this.ctx.createBufferSource();
    source1.buffer = this.buffers.whiteNoise15s;
    const gain1 = this.ctx.createGain();
    applyEnvelope(gain1, this.ctx, { attack: 0.002, decay: 1.5, sustain: 0, release: 0 }, now, 1.5);
    
    const lpSweep = this.ctx.createBiquadFilter();
    lpSweep.type = 'lowpass';
    lpSweep.frequency.setValueAtTime(800, now);
    lpSweep.frequency.exponentialRampToValueAtTime(60, now + 0.5);
    
    const ws = this.ctx.createWaveShaper();
    ws.curve = this._makeDistortionCurve(50);
    
    source1.connect(gain1).connect(lpSweep).connect(ws).connect(destination);

    const source2 = this.ctx.createBufferSource();
    source2.buffer = this.buffers.whiteNoise03s;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    const gain2 = this.ctx.createGain();
    gain2.gain.setValueAtTime(1, now);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    source2.connect(hp).connect(gain2).connect(destination);

    source1.start(now);
    source2.start(now);

    setTimeout(onComplete, 1500);
  }

  impact_shield(now, destination, options, onComplete) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers.whiteNoise03s;
    
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + 0.001);
    env.gain.linearRampToValueAtTime(0, now + 0.3);
    
    source.connect(lp).connect(env).connect(destination);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.15);
    
    const oscEnv = this.ctx.createGain();
    oscEnv.gain.setValueAtTime(1, now);
    oscEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    
    const pk = this.ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.value = 180;
    pk.gain.value = 6;
    
    osc.connect(oscEnv).connect(pk).connect(destination);

    source.start(now);
    osc.start(now);
    setTimeout(onComplete, 300);
  }

  impact_hull(now, destination, options, onComplete) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers.whiteNoise02s;
    
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 3;
    
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(1, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    
    source.connect(bp).connect(env).connect(destination);

    const pitchMod = 0.9 + Math.random() * 0.2;
    
    const osc1 = this.ctx.createOscillator();
    osc1.frequency.value = 800 * pitchMod;
    
    const osc2 = this.ctx.createOscillator();
    osc2.frequency.value = 1200 * pitchMod;
    
    const oscEnv = this.ctx.createGain();
    oscEnv.gain.setValueAtTime(0.5, now);
    oscEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    
    osc1.connect(oscEnv);
    osc2.connect(oscEnv);
    oscEnv.connect(destination);

    source.start(now);
    osc1.start(now);
    osc2.start(now);
    setTimeout(onComplete, 200);
  }

  player_hurt(now, destination, options, onComplete) {
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 180;
    
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 30;
    
    const ringMod = this.ctx.createGain();
    ringMod.gain.value = 0;
    lfo.connect(ringMod.gain);
    
    osc.connect(ringMod);
    
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now);
    env.gain.linearRampToValueAtTime(0, now + 0.25);
    
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    
    const ws = this.ctx.createWaveShaper();
    ws.curve = this._makeDistortionCurve(20);
    
    ringMod.connect(hp).connect(ws).connect(env).connect(destination);
    
    osc.start(now);
    lfo.start(now);
    osc.stop(now + 0.25);
    lfo.stop(now + 0.25);
    setTimeout(onComplete, 250);
  }

  pickup_weapon(now, destination, options, onComplete) {
    const freqs = [523, 659, 784];
    const delayNode = this.ctx.createDelay();
    delayNode.delayTime.value = 0.03;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.2;
    delayNode.connect(feedback);
    feedback.connect(delayNode);
    delayNode.connect(destination);

    freqs.forEach((freq, i) => {
      const t = now + i * 0.08;
      const osc = this.ctx.createOscillator();
      osc.frequency.value = freq;
      const env = this.ctx.createGain();
      applyEnvelope(env, this.ctx, { attack: 0.005, decay: 0, sustain: 0.8, release: 0.1 }, t, 0.12);
      osc.connect(env);
      env.connect(destination);
      env.connect(delayNode);
      osc.start(t);
      osc.stop(t + 0.12);
    });
    setTimeout(onComplete, 500);
  }

  weapon_expired(now, destination, options, onComplete) {
    const osc1 = this.ctx.createOscillator();
    osc1.frequency.setValueAtTime(600, now);
    osc1.frequency.linearRampToValueAtTime(150, now + 0.4);
    
    const osc2 = this.ctx.createOscillator();
    osc2.frequency.setValueAtTime(300, now);
    osc2.frequency.linearRampToValueAtTime(75, now + 0.4);
    
    const gain1 = this.ctx.createGain();
    const gain2 = this.ctx.createGain();
    gain2.gain.value = 0.3;
    
    const master = this.ctx.createGain();
    master.gain.setValueAtTime(1, now);
    master.gain.linearRampToValueAtTime(0, now + 0.4);
    
    osc1.connect(gain1).connect(master);
    osc2.connect(gain2).connect(master);
    master.connect(destination);
    
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.4);
    osc2.stop(now + 0.4);
    setTimeout(onComplete, 400);
  }

  player_respawn(now, destination, options, onComplete) {
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.buffers.whiteNoise06s;
    
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(200, now);
    bp.frequency.linearRampToValueAtTime(4000, now + 0.5);
    
    const noiseEnv = this.ctx.createGain();
    noiseEnv.gain.setValueAtTime(0, now);
    noiseEnv.gain.linearRampToValueAtTime(0.4, now + 0.3);
    noiseEnv.gain.linearRampToValueAtTime(0, now + 0.6);
    
    noise.connect(bp).connect(noiseEnv).connect(destination);
    
    [440, 880, 1320].forEach(f => {
      const osc = this.ctx.createOscillator();
      osc.frequency.value = f;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(0.1, now + 0.3);
      env.gain.linearRampToValueAtTime(0, now + 0.6);
      osc.connect(env).connect(destination);
      osc.start(now);
      osc.stop(now + 0.6);
    });
    
    noise.start(now);
    setTimeout(onComplete, 600);
  }

  ambience_space(now, destination, options, onComplete) {
    const osc1 = this.ctx.createOscillator();
    osc1.frequency.value = 40;
    const lfo1 = this.ctx.createOscillator();
    lfo1.frequency.value = 0.05;
    const l1Gain = this.ctx.createGain();
    l1Gain.gain.value = 3;
    lfo1.connect(l1Gain).connect(osc1.frequency);
    
    const osc2 = this.ctx.createOscillator();
    osc2.frequency.value = 67;
    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.6;
    const lfo2 = this.ctx.createOscillator();
    lfo2.frequency.value = 0.05;
    const l2Gain = this.ctx.createGain();
    l2Gain.gain.value = 3;
    lfo2.connect(l2Gain).connect(osc2.frequency);
    osc2.connect(osc2Gain);
    
    const osc3 = this.ctx.createOscillator();
    osc3.frequency.value = 120;
    const lfo3 = this.ctx.createOscillator();
    lfo3.frequency.value = 0.07;
    const l3Gain = this.ctx.createGain();
    l3Gain.gain.value = 3;
    lfo3.connect(l3Gain).connect(osc3.frequency);

    const master = this.ctx.createGain();
    master.gain.value = 0.05;
    
    osc1.connect(master);
    osc2Gain.connect(master);
    osc3.connect(master);
    master.connect(destination);

    [osc1, osc2, osc3, lfo1, lfo2, lfo3].forEach(n => n.start(now));
    
    options.ambienceNodes = [osc1, osc2, osc3, lfo1, lfo2, lfo3, master];
    
    // Ambience runs continuously; release node count immediately
    onComplete();
  }

  chat_message(now, destination, options, onComplete) {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = 880;
    
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2000;
    
    const env = this.ctx.createGain();
    applyEnvelope(env, this.ctx, { attack: 0.005, decay: 0.05, sustain: 0.5, release: 0.2 }, now, 0.35);
    
    const gain = this.ctx.createGain();
    gain.gain.value = 0.3;
    
    osc.connect(lp).connect(env).connect(gain).connect(destination);
    osc.start(now);
    osc.stop(now + 0.35);
    setTimeout(onComplete, 350);
  }

  ui_click(now, destination, options, onComplete) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers.whiteNoise002s;
    
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value = 5;
    
    source.connect(bp).connect(destination);
    source.start(now);
    setTimeout(onComplete, 20);
  }

  _makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50,
      n_samples = 44100,
      curve = new Float32Array(n_samples),
      deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = i * 2 / n_samples - 1;
      curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  // --- MUSIC SYSTEM ---

  async discoverMusicTracks() {
    try {
      const res = await fetch('music/manifest.php');
      if (!res.ok) return [];
      const data = await res.json();
      this.musicTracks = data.tracks || [];
      
      const musicStatus = document.getElementById('music-status');
      const musicToggle = document.getElementById('music-toggle');
      const musicVolumeSlider = document.getElementById('music-volume');
      
      if (this.musicTracks.length === 0) {
        if (musicStatus) musicStatus.textContent = "No music files found in /music";
        if (musicToggle) {
          musicToggle.disabled = true;
          musicToggle.style.opacity = 0.5;
        }
        if (musicVolumeSlider) {
          musicVolumeSlider.disabled = true;
          musicVolumeSlider.style.opacity = 0.5;
        }
      }

      this._shuffleTracks();
      return this.musicTracks;
    } catch {
      this.musicTracks = [];
      return [];
    }
  }

  _shuffleTracks() {
    for (let i = this.musicTracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.musicTracks[i], this.musicTracks[j]] = [this.musicTracks[j], this.musicTracks[i]];
    }
    this.currentTrackIndex = -1;
  }

  getNextTrack() {
    if (this.musicTracks.length === 0) return null;
    this.currentTrackIndex++;
    if (this.currentTrackIndex >= this.musicTracks.length) {
      this._shuffleTracks();
      this.currentTrackIndex = 0;
    }
    return this.musicTracks[this.currentTrackIndex];
  }

  nextTrack() {
    const next = this.getNextTrack();
    if (next) this.loadAndPlayTrack(next);
  }

  startMusicPlayback() {
    if (this.musicTracks.length === 0) return;
    this._shuffleTracks();
    this.currentTrackIndex = 0;
    this.loadAndPlayTrack(this.musicTracks[0]);
  }

  async loadAndPlayTrack(filename) {
    if (!this.musicEnabled) return;

    try {
      const res = await fetch('music/' + filename);
      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

      const trackGain = this.ctx.createGain();
      const now = this.ctx.currentTime;
      trackGain.gain.setValueAtTime(0, now);
      trackGain.gain.linearRampToValueAtTime(1, now + this.crossfadeTime);
      trackGain.connect(this.musicGain);

      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(trackGain);
      source.start(now);

      if (this.currentTrack) {
        const prevGain = this.currentTrack.trackGain;
        const prevSource = this.currentTrack.source;
        prevGain.gain.setValueAtTime(prevGain.gain.value, now);
        prevGain.gain.linearRampToValueAtTime(0, now + this.crossfadeTime);
        setTimeout(() => {
          prevSource.stop();
          prevGain.disconnect();
        }, this.crossfadeTime * 1000 + 100);
      }

      this.currentTrack = { source, trackGain };

      setTimeout(() => {
        if (this.musicEnabled) {
          const next = this.getNextTrack();
          if (next) this.loadAndPlayTrack(next);
        }
      }, (audioBuffer.duration - this.crossfadeTime) * 1000);

    } catch (e) {
      console.error('Failed to load track:', filename, e);
      // Skip to next on failure
      const next = this.getNextTrack();
      if (next) this.loadAndPlayTrack(next);
    }
  }
}

export const soundManager = new SoundManager();
