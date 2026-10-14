varying vec3 vDir;

void main() {
  vDir = position; // sphere centred on the camera: position is the view direction
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // push to the far plane
}
