uniform vec3 uColor;

varying float vGlow;

void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = pow(smoothstep(0.5, 0.0, d), 2.2);
  gl_FragColor = vec4(uColor * core * vGlow, 1.0);
}
