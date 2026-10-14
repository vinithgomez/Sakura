// Stateless GPU particles for petals and leaves. A particle's whole life is a
// pure function of (uTime, seed): no CPU simulation, no buffers to update.
//
//   age    = (uTime + offset) mod life
//   cycle  = which lap of its life it's on → re-hashed so every lap spawns
//            from a different blossom on the tree
//   flight = gravity + wind drift + spiral flutter + tumbling
//   rest   = if the predicted landing spot is on the island (or the pond) the
//            particle stops there, settles flat and fades; otherwise it keeps
//            falling past the island's edge into the clouds.
//
// Requires common.glsl, wind.glsl, terrain (layout.js).

attribute vec4 aSeed;

uniform sampler2D uSpawn;  // canopy points (xyz)
uniform vec2 uSpawnSize;   // texture size
uniform float uSpawnCount;
uniform float uRate;       // 0..1 emission
uniform float uLife;
uniform float uFall;
uniform float uDrift;
uniform float uFlutter;
uniform float uSpin;
uniform float uScale;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

varying vec3 vNormalW;
varying vec3 vColor;

#include <fog_pars_vertex>

void main() {
  float life = uLife * (0.8 + 0.4 * aSeed.w);
  float t = uTime + aSeed.x * life * 7.0;
  float cycle = floor(t / life);
  float age = t - cycle * life;

  vec3 h = hash33(aSeed.xyz * 91.7 + cycle * 1.618);
  float h2 = hash13(aSeed.zyx * 53.1 + cycle * 2.414);

  // spawn on a random canopy point
  float idx = floor(h.x * uSpawnCount);
  ivec2 st = ivec2(int(mod(idx, uSpawnSize.x)), int(floor(idx / uSpawnSize.x)));
  vec3 spawn = texelFetch(uSpawn, st, 0).xyz + (h - 0.5) * 0.6;

  float fall = uFall * (0.75 + 0.5 * h.y);
  vec2 wind = uWindDir * uDrift * (0.45 + uWindStrength) * (0.6 + 0.8 * h.z);
  float fr = 1.3 + 1.6 * h.x;
  float flutter = uFlutter * (0.5 + h.y);

  // predicted landing (two refinement steps of the ground lookup)
  float tLand = (spawn.y - restHeight(spawn.xz)) / fall;
  vec2 landXZ = spawn.xz + wind * tLand;
  tLand = max((spawn.y - restHeight(landXZ)) / fall, 0.0);
  landXZ = spawn.xz + wind * tLand;
  float onIsland = step(length(landXZ), ISLAND_R * 0.92);
  float landed = onIsland * step(tLand, age);
  float ta = mix(age, min(age, tLand), onIsland);

  vec3 pos = spawn;
  pos.y -= ta * fall;
  pos.xz += wind * ta;
  pos.x += sin(ta * fr + h.y * 6.28) * flutter;
  pos.z += cos(ta * fr * 0.83 + h.z * 6.28) * flutter;
  pos.y += sin(ta * fr * 2.0 + h.x * 6.28) * flutter * 0.25;
  if (landed > 0.5) {
    pos.y = restHeight(pos.xz) + 0.03;
    // drift a little on the water
    float onWater = step(length(pos.xz - POND_C), POND_R);
    pos.xz += onWater * vec2(sin(uTime * 0.3 + h.x * 9.0), cos(uTime * 0.25 + h.y * 9.0)) * 0.05;
  }

  // tumbling, then settling flat after landing
  vec3 axis = normalize(h * 2.0 - 1.0 + vec3(0.0, 0.001, 0.0));
  float ang = ta * uSpin * (0.6 + h.y);
  float since = max(age - tLand, 0.0);
  float wrapped = mod(ang + PI, 2.0 * PI) - PI;
  ang = mix(ang, wrapped * exp(-since * 5.0), landed);
  mat3 rot = axisAngle(vec3(0.0, 1.0, 0.0), h.z * 6.2831) * axisAngle(axis, ang);

  // visibility: emission gate (per lap), fade in/out, vanish far below
  float gate = smoothstep(h2 * 0.92, h2 * 0.92 + 0.08, uRate);
  float fade = smoothstep(0.0, 0.6, age) * (1.0 - smoothstep(life - 2.0, life, age));
  float scale = uScale * (0.75 + 0.5 * h2) * gate * fade * smoothstep(-18.0, -12.0, pos.y);

  vec3 world = pos + rot * (position * scale);
  vNormalW = rot * normal;
  vColor = h.z < 0.5 ? mix(uColorA, uColorB, h.z * 2.0) : mix(uColorB, uColorC, h.z * 2.0 - 1.0);

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
