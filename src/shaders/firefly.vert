// Fireflies (蛍 hotaru): wandering, slowly blinking HDR points. Their colour
// is far above 1.0, so the bloom pass turns each one into a soft halo.

attribute vec3 aHome;
attribute vec4 aSeed;

uniform float uTime;
uniform float uIntensity;
uniform float uSize;
uniform float uScale;

varying float vGlow;

void main() {
  float t = uTime;
  vec3 p = aHome + vec3(
    sin(t * 0.31 * (1.0 + aSeed.x) + aSeed.y * 6.28) * 1.1 + sin(t * 0.9 + aSeed.w * 9.0) * 0.15,
    sin(t * 0.47 * (1.0 + aSeed.y) + aSeed.z * 6.28) * 0.35,
    cos(t * 0.27 * (1.0 + aSeed.z) + aSeed.x * 6.28) * 1.1
  );
  float blink = pow(0.5 + 0.5 * sin(t * (1.1 + aSeed.w * 1.6) + aSeed.x * 30.0), 4.0);
  vGlow = blink * uIntensity;

  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uSize * uScale / -mvPosition.z * (0.5 + 0.5 * blink) * step(0.002, uIntensity);
}
