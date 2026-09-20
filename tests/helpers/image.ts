import type { ImageInput } from "../../src/images.js";

// 1×1 PNG,用于验证附件字节穿过草稿、协议和会话恢复,不验证模型视觉能力。
export const testImage: ImageInput = {
  mimeType: "image/png",
  name: "pixel.png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
};
